import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRelayConnection } from "./ws"

/**
 * Dashboard WS client token propagation (security remediation 2026-11).
 *
 * The relay server gates /ws behind the shared token; browsers cannot set
 * headers on a WebSocket handshake, so the token travels as the ?token=
 * query param (the server accepts header OR query param). The token here is
 * a synthetic test fixture, never a real secret.
 */

class RecordingSocket {
  static created: RecordingSocket[] = []
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    RecordingSocket.created.push(this)
  }
  close() {
    this.closed = true
  }
}

const FAKE_HOST = "relay.example.test:7351"
const FIXTURE_TOKEN = "dashboard-fixture-token-0123456789abcdef"

let originalWebSocket: unknown
let hadOriginalWebSocket: boolean
let originalLocation: unknown
let hadOriginalLocation: boolean

beforeEach(() => {
  RecordingSocket.created.length = 0
  originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
  hadOriginalWebSocket = "WebSocket" in globalThis
  Object.defineProperty(globalThis, "WebSocket", {
    value: RecordingSocket,
    configurable: true,
    writable: true,
  })
  originalLocation = (globalThis as Record<string, unknown>).location
  hadOriginalLocation = "location" in globalThis
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "http:", host: FAKE_HOST },
    configurable: true,
  })
})

afterEach(() => {
  const globals = globalThis as Record<string, unknown>
  if (hadOriginalWebSocket) globals.WebSocket = originalWebSocket
  else delete globals.WebSocket
  if (hadOriginalLocation) globals.location = originalLocation
  else delete globals.location
})

function connect(token?: string, url?: string) {
  const conn = createRelayConnection({
    onEvent: () => {},
    onStatus: () => {},
    ...(token !== undefined ? { token } : {}),
    ...(url !== undefined ? { url } : {}),
  })
  return conn
}

describe("dashboard WS token propagation", () => {
  test("transmits the shared token as the ws query param", () => {
    const conn = connect(FIXTURE_TOKEN)
    expect(RecordingSocket.created).toHaveLength(1)
    expect(RecordingSocket.created[0].url).toBe(
      `ws://${FAKE_HOST}/ws?token=${FIXTURE_TOKEN}`,
    )
    conn.dispose()
  })

  test("an explicit url option overrides the location-derived endpoint (token still appended)", () => {
    const conn = connect(FIXTURE_TOKEN, "wss://other.example.test:9999/ws")
    expect(RecordingSocket.created).toHaveLength(1)
    expect(RecordingSocket.created[0].url).toBe(
      `wss://other.example.test:9999/ws?token=${FIXTURE_TOKEN}`,
    )
    conn.dispose()
  })

  test("no token option means no token query param is sent", () => {
    const conn = connect()
    expect(RecordingSocket.created).toHaveLength(1)
    expect(RecordingSocket.created[0].url).toBe(`ws://${FAKE_HOST}/ws`)
    conn.dispose()
  })
})
