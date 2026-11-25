import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayTransport } from "./relay.ts"

// RelayTransport logs via the plugin logger (state-dir file), so the file
// runs against a temp XDG state dir like the other suites.
let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-relay-transport-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

/** Bounded grace window for negative assertions (nothing is expected). */
async function graceWindow(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("RelayTransport redirect hardening", () => {
  test("a 302 from the relay makes the client call fail rather than follow", async () => {
    const landed: string[] = []
    const decoy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        landed.push(new URL(req.url).pathname)
        return Response.json({ type: "sessions", entries: [] })
      },
    })
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${decoy.port}/exfiltrated` },
        }),
    })

    const transport = new RelayTransport(
      `http://127.0.0.1:${redirector.port}`,
      "redirect-fixture-token",
    )
    try {
      // A compromised relay must not be able to bounce a client call
      // (registered session ids, questions, replies) to a third host: the
      // call fails instead of following.
      await expect(transport.list()).rejects.toThrow()
      await graceWindow(300)
      expect(landed).toHaveLength(0)
    } finally {
      await transport.dispose()
      redirector.stop(true)
      decoy.stop(true)
    }
  })
})
