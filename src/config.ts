import { randomBytes } from "node:crypto"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { getStateDir } from "./xdg.ts"

const RELAY_CONFIG_FILENAME = "cross-session-relay.json"
const SUPPRESSION_FILENAME = "cross-session-suppressed.json"

/**
 * The relay config file carries the shared relay token and the operator's
 * relay host allowlist (security remediation 2026-11), so it is written 0600
 * (owner-only) via tmp + chmod + rename.
 */
interface RelayConfig {
  current: string | null
  history: string[]
  token: string | null
  allowedRelayHosts: string[]
}

function getConfigPath(): string {
  return join(getStateDir(), RELAY_CONFIG_FILENAME)
}

/** Absolute path of the relay config file (operator remediation messages point here). */
export function getRelayConfigPath(): string {
  return getConfigPath()
}

function defaultRelayConfig(): RelayConfig {
  return { current: null, history: [], token: null, allowedRelayHosts: [] }
}

function readConfig(): RelayConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<RelayConfig>
    return {
      current: parsed.current ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null,
      allowedRelayHosts: Array.isArray(parsed.allowedRelayHosts)
        ? parsed.allowedRelayHosts
        : [],
    }
  } catch {
    return defaultRelayConfig()
  }
}

async function writeConfig(config: RelayConfig): Promise<void> {
  const path = getConfigPath()
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    // W1-U2c item C: the file is created 0600 (not default perms + chmod),
    // so the token-bearing content never exists with wide permissions.
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

function normalizeRelayUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://")
}

export function getRelayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envUrl = env.CROSS_SESSION_RELAY_URL?.trim()
  if (envUrl && envUrl.length > 0) return normalizeRelayUrl(envUrl)
  const stored = readConfig().current
  return stored ? normalizeRelayUrl(stored) : null
}

export function getRelayHistory(): string[] {
  return readConfig().history
}

/**
 * Shared token for talking to the configured relay. Resolution order:
 * CROSS_SESSION_RELAY_TOKEN env, RELAY_TOKEN env, then the token stored in
 * the config file (written by connect_relay). Null when nothing is set.
 */
export function getRelayToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.CROSS_SESSION_RELAY_TOKEN?.trim()
  if (override) return override
  const relayEnv = env.RELAY_TOKEN?.trim()
  if (relayEnv) return relayEnv
  return readConfig().token
}

/** Operator-configured relay host allowlist (empty = every connect refused). */
export function getAllowedRelayHosts(): string[] {
  return readConfig().allowedRelayHosts
}

/**
 * Operator-facing allowlist mutator. Deliberately NOT exposed as a tool:
 * the calling model must never be able to widen its own relay permissions.
 */
export async function setAllowedRelayHosts(hosts: string[]): Promise<void> {
  const config = readConfig()
  config.allowedRelayHosts = hosts
  await writeConfig(config)
}

export async function writeRelayUrl(
  url: string,
  token?: string,
): Promise<void> {
  const config = readConfig()
  config.current = url
  if (token !== undefined) {
    config.token = token
  }
  if (!config.history.includes(url)) {
    config.history.unshift(url)
  } else {
    config.history = [url, ...config.history.filter((h) => h !== url)]
  }
  await writeConfig(config)
}

export async function clearRelayUrl(): Promise<void> {
  const config = readConfig()
  config.current = null
  await writeConfig(config)
}

function getSuppressionPath(): string {
  return join(getStateDir(), SUPPRESSION_FILENAME)
}

export function readSuppressedSessions(): Set<string> {
  try {
    const raw = readFileSync(getSuppressionPath(), "utf8")
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function addSuppressedSession(sessionId: string): void {
  const set = readSuppressedSessions()
  set.add(sessionId)
  writeFileSync(getSuppressionPath(), JSON.stringify([...set]))
}

export function clearSuppressedSessions(): void {
  try {
    unlinkSync(getSuppressionPath())
  } catch {
    /* ignore */
  }
}
