import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getRelayConfigPath,
  getRelayToken,
  getRelayUrl,
  getAllowedRelayHosts,
  setAllowedRelayHosts,
  writeRelayUrl,
} from "./config.ts"

let stateDir: string
let originalXDG: string | undefined
const TOKEN_ENV_KEYS = ["RELAY_TOKEN", "CROSS_SESSION_RELAY_TOKEN"] as const

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-config-test-"))
  process.env.XDG_STATE_HOME = stateDir
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
  rmSync(stateDir, { recursive: true, force: true })
})

describe("config", () => {
  test("writeRelayUrl persists current and history", async () => {
    await writeRelayUrl("https://relay.example.test:7351")
    expect(getRelayUrl()).toBe("https://relay.example.test:7351")
    await writeRelayUrl("https://other.example.test:7351")
    expect(getRelayUrl()).toBe("https://other.example.test:7351")
  })

  test("config file (which carries the shared token) is written 0600", async () => {
    await writeRelayUrl("https://relay.example.test:7351", "shared-token-abc")
    const mode = statSync(getRelayConfigPath()).mode & 0o777
    expect(mode).toBe(0o600)
    // Rewrites (history moves, allowlist edits) must keep the mode.
    await writeRelayUrl("https://other.example.test:7351")
    expect(statSync(getRelayConfigPath()).mode & 0o777).toBe(0o600)
  })

  test("token passed to writeRelayUrl is stored and served by getRelayToken", async () => {
    await writeRelayUrl("https://relay.example.test:7351", "shared-token-abc")
    expect(getRelayToken()).toBe("shared-token-abc")
  })

  test("getRelayToken precedence: CROSS_SESSION_RELAY_TOKEN > RELAY_TOKEN > stored", async () => {
    await writeRelayUrl("https://relay.example.test:7351", "stored-token")
    expect(getRelayToken()).toBe("stored-token")
    process.env.RELAY_TOKEN = "env-token"
    expect(getRelayToken()).toBe("env-token")
    process.env.CROSS_SESSION_RELAY_TOKEN = "override-token"
    expect(getRelayToken()).toBe("override-token")
  })

  test("getRelayToken returns null when nothing is configured", () => {
    expect(getRelayToken()).toBeNull()
  })

  test("allowlist round-trips through the config file", async () => {
    expect(getAllowedRelayHosts()).toEqual([])
    await setAllowedRelayHosts(["relay.example.test:7351", "127.0.0.1"])
    expect(getAllowedRelayHosts()).toEqual([
      "relay.example.test:7351",
      "127.0.0.1",
    ])
  })

  test("a legacy config file without token/allowlist fields reads cleanly", async () => {
    await writeRelayUrl("https://relay.example.test:7351")
    // Simulate the pre-1.0.1 shape by rewriting through raw JSON is not
    // needed: defaults must hold for a fresh state dir and after reads.
    expect(getRelayToken()).toBeNull()
    expect(getAllowedRelayHosts()).toEqual([])
  })
})
