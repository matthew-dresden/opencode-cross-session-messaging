import { randomBytes } from "node:crypto"
import * as nodeFs from "node:fs"
import { dirname, join } from "node:path"
import { getStateDir } from "../xdg.ts"

/**
 * Shared-token auth for the relay server (security remediation 2026-11).
 *
 * Resolution order (first non-empty wins):
 *   1. explicit `token` option (RelayServer / CLI --token)
 *   2. `RELAY_TOKEN` env var
 *   3. token file `<stateDir>/opencode/cross-session-relay-token` (0600)
 *   4. generate a cryptographically random token and persist it 0600
 *
 * The token value is NEVER logged: callers print only the file path or the
 * source descriptor (`tokenSourceDescription`).
 */

export const RELAY_TOKEN_FILENAME = "cross-session-relay-token"

/** Tokens shorter than this trigger a loud (never-blocking) warning. */
export const MIN_RECOMMENDED_TOKEN_CHARS = 16

/** True for operator-supplied tokens below the recommended length. Generated tokens (256-bit) never qualify. */
export function isWeakRelayToken(token: string): boolean {
  return token.trim().length < MIN_RECOMMENDED_TOKEN_CHARS
}

/**
 * The synchronous fs operations the token writer uses, behind one object so
 * the remediation tests can observe the creation mode of the token bytes:
 * before W1-U2c the writer created the FINAL path with default perms and
 * chmodded afterwards, leaving a wide-perms window on the highest-value
 * secret that no post-hoc assertion can see. Production always calls
 * through to the real node:fs implementations here.
 */
export const tokenFileFs = {
  writeFileSync: nodeFs.writeFileSync,
  chmodSync: nodeFs.chmodSync,
  renameSync: nodeFs.renameSync,
  unlinkSync: nodeFs.unlinkSync,
}

export interface ResolveRelayTokenOptions {
  /** Explicit token (CLI --token or RelayServerOptions.token). Wins over env. */
  token?: string
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

/** Absolute path of the relay token file. */
export function relayTokenPath(): string {
  return join(getStateDir(), RELAY_TOKEN_FILENAME)
}

/**
 * Where the resolved token came from, for operator-facing output that must
 * never include the token value itself.
 */
export function tokenSourceDescription(opts: ResolveRelayTokenOptions = {}): string {
  const env = opts.env ?? process.env
  if (opts.token?.trim()) return "--token option"
  if (env.RELAY_TOKEN?.trim()) return "RELAY_TOKEN env"
  return `token file ${relayTokenPath()}`
}

export function resolveRelayToken(
  opts: ResolveRelayTokenOptions = {},
): string {
  const env = opts.env ?? process.env

  const explicit = opts.token?.trim()
  if (explicit) return explicit

  const fromEnv = env.RELAY_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const path = relayTokenPath()
  if (nodeFs.existsSync(path)) {
    const fromFile = nodeFs.readFileSync(path, "utf8").trim()
    if (fromFile) return fromFile
  }

  const generated = randomBytes(32).toString("base64url")
  nodeFs.mkdirSync(dirname(path), { recursive: true })
  // Atomic 0600 write (W1-U2c item C): the token is written to a temp file
  // created with mode 0600, re-chmodded as belt-and-braces, then renamed
  // onto the final path, so the secret never exists with wide permissions,
  // not even transiently.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    tokenFileFs.writeFileSync(tmp, generated, {
      encoding: "utf8",
      mode: 0o600,
    })
    tokenFileFs.chmodSync(tmp, 0o600)
    tokenFileFs.renameSync(tmp, path)
  } catch (err) {
    try {
      tokenFileFs.unlinkSync(tmp)
    } catch {
      /* the tmp file may not exist when the write itself failed */
    }
    throw err
  }
  return generated
}
