import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import { STALE_ENTRY_TTL_MS } from "./constants.ts"
import type { Registry, RegistryEntry } from "./types.ts"
import { REGISTRY_SCHEMA_VERSION } from "./types.ts"
import { getRegistryPath } from "./xdg.ts"

/**
 * Atomic registry I/O. Corresponds to executable plan §T7.
 *
 * Concurrency model:
 * - In-process: an async promise chain (`writeChain`) serializes all
 *   read-modify-write ops from the same daemon process. Multiple sessions
 *   share this module.
 * - Cross-process: guarded by the POSIX temp+rename atomicity inside
 *   `writeRegistry`. Same-filesystem rename is atomic — readers never
 *   observe a half-written file. Last write across processes wins.
 * - Corrupt files: surface a clear "corrupt: invalid JSON" error rather
 *   than silently returning empty. Recovery is manual: delete the file
 *   and let the first `upsertEntry` re-create it.
 */
let writeChain: Promise<unknown> = Promise.resolve()

function emptyFile(): Registry {
  return { version: REGISTRY_SCHEMA_VERSION, sessions: {} }
}

/**
 * Read the full registry.
 * - ENOENT → returns an empty file (no error).
 * - Invalid JSON → throws `Error` with "corrupt: invalid JSON (…)".
 * - Wrong schema / non-object root / non-object `sessions` → throws
 *   `Error` with "corrupt: …" explaining the shape mismatch.
 */
export async function readRegistry(): Promise<Registry> {
  const path = getRegistryPath()
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return emptyFile()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Registry file at ${path} corrupt: invalid JSON (${msg})`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Registry file at ${path} corrupt: root is not an object`)
  }
  const candidate = parsed as { version?: unknown; sessions?: unknown }
  if (candidate.version !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Registry file at ${path} corrupt: unknown schema version ${String(candidate.version)}`,
    )
  }
  if (typeof candidate.sessions !== "object" || candidate.sessions === null) {
    throw new Error(`Registry file at ${path} corrupt: sessions is not an object`)
  }
  return {
    version: REGISTRY_SCHEMA_VERSION,
    sessions: candidate.sessions as Registry["sessions"],
  }
}

/**
 * Persist the whole registry atomically:
 *   `<path>.<pid>.<randomHex>.tmp` → `fs.writeFile` → `fs.rename` over target.
 * On write failure, best-effort `fs.unlink` on the tmp file.
 */
export async function writeRegistry(next: Registry): Promise<void> {
  const path = getRegistryPath()
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  const json = JSON.stringify(next, null, 2)
  try {
    await fs.writeFile(tmp, json, {
      encoding: "utf8",
      // Security remediation 2026-11: the registry carries session metadata
      // (summaries, directories), so it is owner-only (0600) from creation
      // (W1-U2c item C: mode at creation, chmod kept as belt-and-braces).
      mode: 0o600,
    })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup — swallow cleanup failure so we do not hide the
    // real write error from the caller.
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * Upsert the calling session's entry. `registeredAt` is preserved on
 * subsequent calls; only `updatedAt` moves forward. Serialized via the
 * in-process mutex chain.
 */
export async function upsertEntry(
  entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
): Promise<RegistryEntry> {
  let result: RegistryEntry | undefined
  const run = async (): Promise<void> => {
    const file = await readRegistry()
    const now = Date.now()
    const existing = file.sessions[entry.sessionId]
    result = {
      ...entry,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }
    file.sessions[entry.sessionId] = result
    await writeRegistry(file)
  }
  // `.then(run, run)` — same handler for both branches so one op's
  // failure does not permanently break the chain. Each caller's own
  // `await writeChain` still sees its own success/failure via the
  // promise captured at await time.
  writeChain = writeChain.then(run, run)
  await writeChain
  if (!result) {
    throw new Error("registry.upsertEntry: internal — result unset after run")
  }
  return result
}

/**
 * Read all live entries, sorted by `updatedAt` desc (most recent first).
 * Stale entries (`updatedAt` older than `STALE_ENTRY_TTL_MS`) are
 * filtered out — defense-in-depth for a missed `session.deleted`.
 */
export async function listEntries(): Promise<RegistryEntry[]> {
  const file = await readRegistry()
  const cutoff = Date.now() - STALE_ENTRY_TTL_MS
  return Object.values(file.sessions)
    .filter((e) => e.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Delete a session's entry. Called from the `session.deleted` event hook.
 * Returns `true` if a matching entry was removed, `false` if the entry
 * did not exist (no-op, no error).
 */
export async function removeEntry(sessionId: string): Promise<boolean> {
  let removed = false
  const run = async (): Promise<void> => {
    const file = await readRegistry()
    if (!(sessionId in file.sessions)) return
    delete file.sessions[sessionId]
    removed = true
    await writeRegistry(file)
  }
  writeChain = writeChain.then(run, run)
  await writeChain
  return removed
}
