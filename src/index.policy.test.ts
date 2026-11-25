import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.ts"
import { getRelayConfigPath, setAllowedRelayHosts, writeRelayUrl } from "./config.ts"

/**
 * Plugin-entry policy wiring (security remediation 2026-11, AzDO #2849).
 *
 * The relay policy (https-default + operator host allowlist + shared token)
 * must be enforced where relay URLs are HONORED, not only where they are
 * typed: plugin init and the config poller. Both the V1 server() shape and
 * the V2 setup() shape share wireDaemon, so these tests drive the V1 surface
 * against a real recording HTTP server on loopback.
 *
 * The relay token below is a synthetic test fixture, never a real secret.
 */

const FIXTURE_TOKEN = "w1u2-fixture-token-0123456789abcdef"
const TOKEN_ENV_KEYS = ["RELAY_TOKEN", "CROSS_SESSION_RELAY_TOKEN"] as const

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-index-policy-test-"))
  process.env.XDG_STATE_HOME = stateDir
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
  rmSync(stateDir, { recursive: true, force: true })
})

function makeFakeInput(): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {
      id: "test_project_policy",
      worktree: "/tmp/wt",
      time: { created: 0 },
    },
    directory: "/tmp/dir",
    worktree: "/tmp/wt",
    serverUrl: new URL("http://localhost:1234"),
    experimental_workspace: { register: () => {} },
    $: (() => {}) as unknown as PluginInput["$"],
  } as unknown as PluginInput
}

interface RecordedRequest {
  method: string
  path: string
  auth: string | null
}

async function startRecordingRelay(): Promise<{
  port: number
  requests: RecordedRequest[]
  stop: () => void
}> {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
      })
      return Response.json({ messages: [] })
    },
  })
  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error("recording relay failed to bind an ephemeral port")
  }
  return { port, requests, stop: () => server.stop(true) }
}

/** Active readiness detection: poll the condition; throw past the deadline. */
async function waitFor(
  probe: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${what}`)
}

/** Bounded grace window for negative assertions (no traffic is expected). */
async function graceWindow(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("plugin entry relay-policy wiring", () => {
  test("init connects the stored allowlisted relay and authenticates with the shared token", async () => {
    const relay = await startRecordingRelay()
    await setAllowedRelayHosts([`127.0.0.1:${relay.port}`])
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`, FIXTURE_TOKEN)

    const hooks = await plugin.server(makeFakeInput())
    await waitFor(
      () => relay.requests.some((r) => r.path === "/api/poll"),
      3000,
      "relay poll after init",
    )
    expect(
      relay.requests.some((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`),
    ).toBe(true)

    await hooks.dispose?.()
    relay.stop()
  })

  test("init refuses a stored relay whose host is not allowlisted (no relay traffic)", async () => {
    const relay = await startRecordingRelay()
    // No allowlist configured: every relay connect must be refused.
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`, FIXTURE_TOKEN)

    const hooks = await plugin.server(makeFakeInput())
    await graceWindow(800)
    expect(relay.requests).toHaveLength(0)

    await hooks.dispose?.()
    relay.stop()
  })

  test("config poller honors the policy on URL change (connects allowlisted URL with token)", async () => {
    const relay = await startRecordingRelay()
    await setAllowedRelayHosts([`127.0.0.1:${relay.port}`])
    // Init runs with NO stored relay (file IPC); the relay appears via a
    // config-file change, which the poller must evaluate through the policy.
    const hooks = await plugin.server(makeFakeInput())
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`, FIXTURE_TOKEN)

    await waitFor(
      () =>
        relay.requests.some(
          (r) =>
            r.path === "/api/poll" && r.auth === `Bearer ${FIXTURE_TOKEN}`,
        ),
      6000,
      "authorized relay poll after config change",
    )

    await hooks.dispose?.()
    relay.stop()
  }, 10_000)

  test("config poller refuses an unallowlisted URL change (no relay traffic)", async () => {
    const relay = await startRecordingRelay()
    await setAllowedRelayHosts(["relay.example.test:7351"])
    const hooks = await plugin.server(makeFakeInput())
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`)

    // Longer than CONFIG_POLL_MS (2s) so the poller has evaluated the change.
    await graceWindow(3500)
    expect(relay.requests).toHaveLength(0)

    await hooks.dispose?.()
    relay.stop()
  })

  test("fixing the allowlist alone reconnects the relay without a URL change", async () => {
    const relay = await startRecordingRelay()
    // Init runs with a stored relay whose host is NOT allowlisted: refusal.
    await setAllowedRelayHosts(["relay.example.test:7351"])
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`, FIXTURE_TOKEN)
    const hooks = await plugin.server(makeFakeInput())

    // Longer than CONFIG_POLL_MS (2s): the refused state must persist until
    // the operator actually fixes something.
    await graceWindow(2500)
    expect(relay.requests).toHaveLength(0)

    // The operator fixes ONLY the allowlist (the URL stays byte-identical).
    await setAllowedRelayHosts([`127.0.0.1:${relay.port}`])
    await waitFor(
      () =>
        relay.requests.some(
          (r) =>
            r.path === "/api/poll" && r.auth === `Bearer ${FIXTURE_TOKEN}`,
        ),
      6000,
      "authorized relay poll after allowlist fix (URL unchanged)",
    )

    await hooks.dispose?.()
    relay.stop()
  }, 12_000)

  test("narrowing the allowlist tears down the live relay transport", async () => {
    const relay = await startRecordingRelay()
    await setAllowedRelayHosts([`127.0.0.1:${relay.port}`])
    await writeRelayUrl(`http://127.0.0.1:${relay.port}`, FIXTURE_TOKEN)
    const hooks = await plugin.server(makeFakeInput())
    await waitFor(
      () => relay.requests.length > 0,
      4000,
      "live relay polls after init",
    )

    // Narrow the allowlist away from the live relay host (URL unchanged).
    await setAllowedRelayHosts(["relay.example.test:7351"])

    // Settle through the teardown window (CONFIG_POLL_MS is 2s): in-flight
    // polls from before the narrowing may still land here.
    await graceWindow(2500)

    // From here on the relay must see NO further traffic: the live transport
    // was torn down (file IPC fallback).
    const before = relay.requests.length
    await graceWindow(3500)
    expect(relay.requests.length).toBe(before)

    await hooks.dispose?.()
    relay.stop()
  }, 12_000)

  test("a successful connect_relay does not trigger a second poller switch (transport identity stable)", async () => {
    const relay = await startRecordingRelay()
    await setAllowedRelayHosts([`127.0.0.1:${relay.port}`])
    const hooks = await plugin.server(makeFakeInput())

    // Track a session while on file IPC: every later switchTo re-registers
    // it on the new inner transport, which makes each switch observable on
    // the recording relay as one POST /api/register.
    await hooks.tool?.register_session.execute(
      { summary: "w1u2d transport stability fixture" },
      {
        sessionID: "ses_w1u2d_stable",
        directory: "/tmp/w1u2d",
      } as never,
    )
    expect(relay.requests).toHaveLength(0)

    // The tool switches the transport once (switch #1 registers the
    // tracked session on the relay).
    const connect = await hooks.tool?.connect_relay.execute(
      {
        url: `http://127.0.0.1:${relay.port}`,
        token: FIXTURE_TOKEN,
      },
      { sessionID: "ses_w1u2d_stable", directory: "/tmp/w1u2d" } as never,
    )
    expect(connect).toMatchObject({ title: "connected" })
    await waitFor(
      () => relay.requests.some((r) => r.path === "/api/register"),
      4000,
      "tracked session registered on connect_relay switch",
    )

    // Advance past one poll cycle (CONFIG_POLL_MS 2s) plus margin: the
    // digest changed (connect_relay persisted url+token), but the URL and
    // token are semantically unchanged, so the poller must keep the live
    // transport (no dispose, no re-register).
    await graceWindow(3500)

    const registers = relay.requests.filter((r) => r.path === "/api/register")
    expect(registers).toHaveLength(1)

    await hooks.dispose?.()
    relay.stop()
  }, 12_000)

  test("restoring a previously-seen config digest still tears down a tool-connected relay (flap window)", async () => {
    const relay = await startRecordingRelay()
    const allowlist = [`127.0.0.1:${relay.port}`]
    await setAllowedRelayHosts(allowlist)
    const hooks = await plugin.server(makeFakeInput())

    // connect_relay succeeds against an allowlisted URL; the relay starts
    // polling. The wiring must be notified of this tool-initiated switch.
    const connect = await hooks.tool?.connect_relay.execute(
      {
        url: `http://127.0.0.1:${relay.port}`,
        token: FIXTURE_TOKEN,
      },
      { sessionID: "ses_w1u2d_flap", directory: "/tmp/w1u2d" } as never,
    )
    expect(connect).toMatchObject({ title: "connected" })
    await waitFor(
      () => relay.requests.length > 0,
      4000,
      "relay polls after connect_relay",
    )

    // Return the config content to the exact pre-connect values (no relay
    // URL, no token, same allowlist) within one poll window, so the raw
    // digest comparison equals the init-time digest and would skip.
    writeFileSync(
      getRelayConfigPath(),
      JSON.stringify(
        {
          current: null,
          history: [],
          token: null,
          allowedRelayHosts: allowlist,
        },
        null,
        2,
      ),
    )

    // Settle through one poll cycle: the forced re-evaluation must observe
    // the absent relay URL and tear the tool-connected relay down (the live
    // inner is no longer a RelayTransport, so its polls stop).
    await graceWindow(2500)
    const before = relay.requests.length
    await graceWindow(3500)
    expect(relay.requests.length).toBe(before)

    await hooks.dispose?.()
    relay.stop()
  }, 12_000)
})
