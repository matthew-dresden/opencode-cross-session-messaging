import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getStateDir } from "../xdg.ts"
import { RELAY_TOKEN_FILENAME, resolveRelayToken } from "./token.ts"

// Fresh temp state dir per test so token generation never touches real state.
let stateDir: string
let originalXDG: string | undefined
const TOKEN_ENV_KEYS = ["RELAY_TOKEN", "CROSS_SESSION_RELAY_TOKEN"] as const

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-relay-token-test-"))
  process.env.XDG_STATE_HOME = stateDir
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
  rmSync(stateDir, { recursive: true, force: true })
})

describe("resolveRelayToken", () => {
  test("explicit token option wins over env and file", () => {
    process.env.RELAY_TOKEN = "env-token-value"
    const dir = join(stateDir, "opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, RELAY_TOKEN_FILENAME), "file-token-value")
    expect(resolveRelayToken({ token: "explicit-token" })).toBe(
      "explicit-token",
    )
  })

  test("reads RELAY_TOKEN env when no explicit token is given", () => {
    process.env.RELAY_TOKEN = "env-token-value"
    expect(resolveRelayToken({})).toBe("env-token-value")
  })

  test("reads an existing token file", () => {
    const dir = join(stateDir, "opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, RELAY_TOKEN_FILENAME), "file-token-value\n")
    expect(resolveRelayToken({})).toBe("file-token-value")
  })

  test("generates a 0600 token file when nothing is configured", () => {
    const token = resolveRelayToken({})
    expect(token.length).toBeGreaterThan(20)
    const path = join(getStateDir(), RELAY_TOKEN_FILENAME)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(token)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("generated token is stable: the file is reused on the next call", () => {
    const first = resolveRelayToken({})
    const second = resolveRelayToken({})
    expect(second).toBe(first)
  })

  test("blank env and blank file values are ignored (generation kicks in)", () => {
    process.env.RELAY_TOKEN = "   "
    const dir = join(stateDir, "opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, RELAY_TOKEN_FILENAME), "  \n")
    const token = resolveRelayToken({})
    expect(token).not.toBe("")
    const path = join(getStateDir(), RELAY_TOKEN_FILENAME)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, "utf8")).toBe(token)
  })

  test("the generated token file is created 0600 at write time (no wide-perms window)", async () => {
    // Final-mode assertions cannot see the pre-remediation wide-perms
    // window: the legacy writer created the FINAL path with default perms
    // and chmodded afterwards. The creation-mode contract is therefore
    // observed at the fs seam: every write that carries the token bytes
    // must pass mode 0600 and must not target the final path.
    const mod = (await import("./token.ts")) as {
      tokenFileFs?: {
        writeFileSync: (
          path: Parameters<typeof import("node:fs").writeFileSync>[0],
          data: Parameters<typeof import("node:fs").writeFileSync>[1],
          options?: Parameters<typeof import("node:fs").writeFileSync>[2],
        ) => void
      }
    }
    if (!mod.tokenFileFs) {
      throw new Error(
        "token writer has no observable fs seam (tokenFileFs): the legacy write path cannot demonstrate its creation mode",
      )
    }
    const real = mod.tokenFileFs.writeFileSync
    const recorded: Array<{ path: string; mode: unknown }> = []
    mod.tokenFileFs.writeFileSync = ((path, data, options) => {
      recorded.push({
        path: String(path),
        mode:
          typeof options === "object" && options !== null
            ? (options as { mode?: unknown }).mode
            : undefined,
      })
      return real(path, data, options)
    }) as typeof mod.tokenFileFs.writeFileSync
    try {
      const token = resolveRelayToken({})
      const path = join(getStateDir(), RELAY_TOKEN_FILENAME)
      // The token bytes were written exactly once, through the seam, to a
      // temp path (never directly onto the final path), created 0600.
      expect(recorded).toHaveLength(1)
      expect(recorded[0].path).not.toBe(path)
      expect(recorded[0].mode).toBe(0o600)
      // The real write happened: the final file carries the generated token
      // and is owner-only.
      expect(readFileSync(path, "utf8")).toBe(token)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      mod.tokenFileFs.writeFileSync = real
    }
  })
})
