import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  listEntries,
  readRegistry,
  removeEntry,
  upsertEntry,
  writeRegistry,
} from "./registry.ts"
import type { RegistryEntry } from "./types.ts"
import { REGISTRY_SCHEMA_VERSION } from "./types.ts"
import { getRegistryPath } from "./xdg.ts"

// Point `XDG_STATE_HOME` at a fresh temp dir per test so writes don't
// clobber the developer's real registry and tests don't interfere with
// each other.
let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-registry-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

function makeEntry(overrides: Partial<RegistryEntry>): RegistryEntry {
  const now = Date.now()
  return {
    sessionId: "ses_x",
    summary: "default summary",
    directory: "/tmp/default",
    projectId: "p_default",
    registeredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("registry", () => {
  test("readRegistry on missing file returns empty { version, sessions: {} }", async () => {
    const reg = await readRegistry()
    expect(reg).toEqual({
      version: REGISTRY_SCHEMA_VERSION,
      sessions: {},
    })
  })

  test("readRegistry on invalid JSON throws with 'corrupt'", async () => {
    const path = getRegistryPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "{not valid json", "utf8")
    await expect(readRegistry()).rejects.toThrow(/corrupt/i)
  })

  test("writeRegistry then readRegistry round-trips", async () => {
    const entry = makeEntry({ sessionId: "ses_a", summary: "hello" })
    await writeRegistry({
      version: REGISTRY_SCHEMA_VERSION,
      sessions: { ses_a: entry },
    })
    const reg = await readRegistry()
    expect(reg.sessions.ses_a).toEqual(entry)
  })

  test("upsertEntry on empty registry creates entry, registeredAt === updatedAt", async () => {
    const result = await upsertEntry({
      sessionId: "ses_1",
      summary: "first",
      directory: "/tmp/r1",
      projectId: "p1",
    })
    expect(result.sessionId).toBe("ses_1")
    expect(result.summary).toBe("first")
    expect(result.registeredAt).toBe(result.updatedAt)

    const reg = await readRegistry()
    expect(reg.sessions.ses_1).toEqual(result)
  })

  test("upsertEntry on existing session preserves registeredAt, bumps updatedAt", async () => {
    const first = await upsertEntry({
      sessionId: "ses_1",
      summary: "first",
      directory: "/tmp/r1",
      projectId: "p1",
    })
    // Sleep so the second update's timestamp is measurably later.
    await new Promise((r) => setTimeout(r, 10))
    const second = await upsertEntry({
      sessionId: "ses_1",
      summary: "second",
      directory: "/tmp/r1",
      projectId: "p1",
    })
    expect(second.registeredAt).toBe(first.registeredAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.summary).toBe("second")
  })

  test("removeEntry removes existing (returns true); no error if entry missing (returns false)", async () => {
    await upsertEntry({
      sessionId: "ses_1",
      summary: "x",
      directory: "/tmp",
      projectId: "p1",
    })
    expect(await removeEntry("ses_1")).toBe(true)
    const reg = await readRegistry()
    expect(reg.sessions.ses_1).toBeUndefined()

    // No-op on missing entry
    expect(await removeEntry("ses_nonexistent")).toBe(false)
  })

  test("listEntries returns entries sorted by updatedAt desc", async () => {
    await upsertEntry({
      sessionId: "ses_old",
      summary: "old",
      directory: "/tmp",
      projectId: "p1",
    })
    await new Promise((r) => setTimeout(r, 10))
    await upsertEntry({
      sessionId: "ses_mid",
      summary: "mid",
      directory: "/tmp",
      projectId: "p1",
    })
    await new Promise((r) => setTimeout(r, 10))
    await upsertEntry({
      sessionId: "ses_new",
      summary: "new",
      directory: "/tmp",
      projectId: "p1",
    })
    const entries = await listEntries()
    expect(entries.map((e) => e.sessionId)).toEqual([
      "ses_new",
      "ses_mid",
      "ses_old",
    ])
  })

  test("concurrent upsertEntry with 20 different IDs → 20 entries, no drops", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      upsertEntry({
        sessionId: `ses_${i}`,
        summary: `s${i}`,
        directory: "/tmp",
        projectId: "p1",
      }),
    )
    await Promise.all(promises)
    const entries = await listEntries()
    expect(entries).toHaveLength(20)
    const ids = new Set(entries.map((e) => e.sessionId))
    for (let i = 0; i < 20; i++) {
      expect(ids.has(`ses_${i}`)).toBe(true)
    }
  })

  test("concurrent upsertEntry with the SAME ID → 1 entry, no file corruption", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      upsertEntry({
        sessionId: "ses_hot",
        summary: `s${i}`,
        directory: "/tmp",
        projectId: "p1",
      }),
    )
    await Promise.all(promises)
    const entries = await listEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sessionId).toBe("ses_hot")
    // Atomic-write invariant: file on disk must parse as valid JSON.
    const raw = await readFile(getRegistryPath(), "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test("corrupt registry surfaces a clean 'invalid JSON' error message", async () => {
    const path = getRegistryPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "{not valid json", "utf8")
    let caught: Error | undefined
    try {
      await readRegistry()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught?.message).toMatch(/corrupt/i)
    expect(caught?.message).toMatch(/invalid JSON/i)
  })

  test("registry file is written 0600 (owner-only)", async () => {
    const { stat } = await import("node:fs/promises")
    await upsertEntry({
      sessionId: "ses_perm",
      summary: "perm check",
      directory: "/tmp",
      projectId: "p1",
    })
    const fileStat = await stat(getRegistryPath())
    expect(fileStat.mode & 0o777).toBe(0o600)
  })
})
