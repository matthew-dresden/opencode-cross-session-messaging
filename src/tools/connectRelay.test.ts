import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DelegatingTransport } from "../transport/delegating.ts"
import type { ITransport } from "../transport/interface.ts"
import {
  getRelayConfigPath,
  getRelayToken,
  getRelayUrl,
  setAllowedRelayHosts,
} from "../config.ts"
import { connectRelayCore } from "./connectRelay.ts"

let stateDir: string
let originalXDG: string | undefined
const TOKEN_ENV_KEYS = ["RELAY_TOKEN", "CROSS_SESSION_RELAY_TOKEN"] as const

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-connect-relay-test-"))
  process.env.XDG_STATE_HOME = stateDir
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
  rmSync(stateDir, { recursive: true, force: true })
})

function stubDeps(): {
  deps: Parameters<typeof connectRelayCore>[0]
  switched: ITransport[]
  lastKnown: string | null
} {
  const switched: ITransport[] = []
  let lastKnown: string | null = null
  const deps = {
    transport: {
      switchTo: async (t: ITransport) => {
        switched.push(t)
      },
    } as unknown as DelegatingTransport,
    setLastKnownUrl: (url: string) => {
      lastKnown = url
    },
  }
  return { deps, switched, get lastKnown() { return lastKnown } }
}

describe("connectRelay allowlist gate", () => {
  test("empty allowlist refuses with typed remediation and connects nothing", async () => {
    const { deps, switched } = stubDeps()
    const result = await connectRelayCore(deps, "https://relay.example.test:7351")
    expect(result.title).toBe("refused")
    expect(result.output).toContain("allowedRelayHosts")
    expect(result.output).toContain(getRelayConfigPath())
    expect(switched).toHaveLength(0)
    expect(getRelayUrl()).toBeNull()
  })

  test("allowlisted https host connects, persists, and notifies the poller", async () => {
    await setAllowedRelayHosts(["relay.example.test:7351"])
    const stub = stubDeps()
    const { deps, switched } = stub
    const result = await connectRelayCore(
      deps,
      "https://relay.example.test:7351",
    )
    expect(result.title).toBe("connected")
    expect(result.output).toContain("https://relay.example.test:7351")
    expect(switched).toHaveLength(1)
    expect(stub.lastKnown).toBe("https://relay.example.test:7351")
    expect(getRelayUrl()).toBe("https://relay.example.test:7351")
  })

  test("non-loopback http is refused with an https remediation", async () => {
    await setAllowedRelayHosts(["relay.example.test"])
    const { deps, switched } = stubDeps()
    const result = await connectRelayCore(deps, "http://relay.example.test:7351")
    expect(result.title).toBe("refused")
    expect(result.output).toMatch(/https/)
    expect(switched).toHaveLength(0)
    expect(getRelayUrl()).toBeNull()
  })

  test("loopback http passes when allowlisted (local dev exception)", async () => {
    await setAllowedRelayHosts(["127.0.0.1"])
    const { deps, switched } = stubDeps()
    const result = await connectRelayCore(deps, "http://127.0.0.1:7351")
    expect(result.title).toBe("connected")
    expect(switched).toHaveLength(1)
  })

  test("unallowlisted host is refused even with https", async () => {
    await setAllowedRelayHosts(["relay.example.test"])
    const { deps, switched } = stubDeps()
    const result = await connectRelayCore(
      deps,
      "https://collector.example.test:443",
    )
    expect(result.title).toBe("refused")
    expect(result.output).toContain("collector.example.test:443")
    expect(switched).toHaveLength(0)
  })

  test("an explicit token is persisted and the config file stays 0600", async () => {
    await setAllowedRelayHosts(["relay.example.test:7351"])
    const { deps } = stubDeps()
    const result = await connectRelayCore(
      deps,
      "https://relay.example.test:7351",
      "shared-token-xyz",
    )
    expect(result.title).toBe("connected")
    expect(getRelayToken()).toBe("shared-token-xyz")
    expect(statSync(getRelayConfigPath()).mode & 0o777).toBe(0o600)
  })

  test("garbage URL is refused as invalid", async () => {
    const { deps, switched } = stubDeps()
    const result = await connectRelayCore(deps, "not a url")
    expect(result.title).toBe("refused")
    expect(switched).toHaveLength(0)
  })
})

describe("connectRelay weak-token warning", () => {
  test("a short token warns loudly but still connects", async () => {
    await setAllowedRelayHosts(["relay.example.test:7351"])
    const { deps } = stubDeps()
    const result = await connectRelayCore(
      deps,
      "https://relay.example.test:7351",
      "abc",
    )
    // Never warn-then-refuse: the short token is used.
    expect(result.title).toBe("connected")
    expect(getRelayToken()).toBe("abc")
    // The warning is loud (returned to the calling model and logged); it
    // never carries the token value itself.
    expect(result.output).toContain("shorter than 16")
    expect(result.output).not.toContain("abc")
  })

  test("a 32-char token does not trigger the warning", async () => {
    await setAllowedRelayHosts(["relay.example.test:7351"])
    const { deps } = stubDeps()
    const result = await connectRelayCore(
      deps,
      "https://relay.example.test:7351",
      "a".repeat(32),
    )
    expect(result.title).toBe("connected")
    expect(result.output).not.toContain("shorter than 16")
  })
})
