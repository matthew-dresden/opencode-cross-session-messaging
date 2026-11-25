import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getStateDir } from "../xdg.ts"
import { RelayServer } from "./server.ts"

const TOKEN = "test-token-red-green-refactor"
const SECRET_QUESTION = "TOPSECRET-QUESTION-TEXT"

let stateDir: string
let originalXDG: string | undefined
let server: RelayServer | null = null

const TOKEN_ENV_KEYS = ["RELAY_TOKEN", "CROSS_SESSION_RELAY_TOKEN"] as const

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-relay-server-test-"))
  process.env.XDG_STATE_HOME = stateDir
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  server?.stop()
  server = null
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
  rmSync(stateDir, { recursive: true, force: true })
})

function startServer(opts?: Partial<{
  host: string
  previews: boolean
}>): RelayServer {
  const s = new RelayServer({ port: 0, token: TOKEN, ...opts })
  s.start()
  server = s
  return s
}

function baseUrl(s: RelayServer): string {
  return `http://127.0.0.1:${s.actualPort}`
}

async function registerTestSession(s: RelayServer): Promise<void> {
  const res = await fetch(`${baseUrl(s)}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      clientId: "client-1",
      sessionId: "ses_a",
      summary: "test session",
      directory: "/tmp",
      projectId: "p1",
    }),
  })
  expect(res.status).toBe(200)
}

function awaitFirstWsMessage(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no WebSocket message within timeout")),
      4000,
    )
    ws.onmessage = (e) => {
      clearTimeout(timer)
      resolve(String(e.data))
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("WebSocket error"))
    }
  })
}

describe("RelayServer auth gate", () => {
  test("/stats without a token is rejected 401 with WWW-Authenticate", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/stats`)
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
  })

  test("/stats with the bearer token returns 200", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { peers: unknown[] }
    expect(Array.isArray(body.peers)).toBe(true)
  })

  test("/stats with the query-param token returns 200", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/stats?token=${encodeURIComponent(TOKEN)}`)
    expect(res.status).toBe(200)
  })

  test("/stats with a wrong token is rejected 401", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  test("accepts the bearer scheme case-insensitively (RFC 7235)", async () => {
    const s = startServer()
    for (const scheme of ["bearer", "Bearer", "BEARER"]) {
      const res = await fetch(`${baseUrl(s)}/stats`, {
        headers: { Authorization: `${scheme} ${TOKEN}` },
      })
      expect(res.status).toBe(200)
    }
  })

  test("a lowercase bearer scheme with a wrong token is still rejected", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: "bearer wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  test("POST /api/list without auth is rejected 401 before any handler runs", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/api/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "c", requestId: "r" }),
    })
    expect(res.status).toBe(401)
  })

  test("POST /api/list with auth returns the session list", async () => {
    const s = startServer()
    await registerTestSession(s)
    const res = await fetch(`${baseUrl(s)}/api/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ clientId: "client-1", requestId: "r1" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { type: string; entries: unknown[] }
    expect(body.type).toBe("sessions")
    expect(body.entries).toHaveLength(1)
  })

  test("/ws without a token is rejected (401) before upgrade handling", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/ws`)
    expect(res.status).toBe(401)
  })

  test("/ws with a token but no upgrade headers falls through to 400", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/ws?token=${encodeURIComponent(TOKEN)}`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Expected WebSocket upgrade")
  })

  test("static dashboard assets stay reachable (no data behind them)", async () => {
    const s = startServer()
    const res = await fetch(`${baseUrl(s)}/`)
    expect(res.status).toBe(200)
  })

  test("the server log file never contains the token", async () => {
    const s = startServer()
    await fetch(`${baseUrl(s)}/stats`) // rejected
    await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: "Bearer wrong-token" },
    }) // rejected
    await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }) // accepted
    const logPath = join(getStateDir(), "cross-session-relay-server.log")
    expect(existsSync(logPath)).toBe(true)
    const log = readFileSync(logPath, "utf8")
    expect(log).not.toContain(TOKEN)
    expect(log).not.toContain("wrong-token")
  })
})

describe("RelayServer WebSocket snapshot privacy", () => {
  test("authed WS receives a snapshot that carries no question content by default", async () => {
    const s = startServer()
    await registerTestSession(s)
    const askRes = await fetch(`${baseUrl(s)}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        clientId: "client-1",
        requestId: "req-1",
        toSessionId: "ses_a",
        question: SECRET_QUESTION,
        timeoutMs: 5000,
      }),
    })
    expect(askRes.status).toBe(200)

    const ws = new WebSocket(
      `ws://127.0.0.1:${s.actualPort}/ws?token=${encodeURIComponent(TOKEN)}`,
    )
    try {
      const snapshot = await awaitFirstWsMessage(ws)
      expect(snapshot).not.toContain(SECRET_QUESTION)
      const parsed = JSON.parse(snapshot) as { type: string }
      expect(parsed.type).toBe("snapshot")
    } finally {
      ws.close()
    }
  })

  test("with previews enabled the snapshot may carry the preview (opt-in)", async () => {
    const s = startServer({ previews: true })
    await registerTestSession(s)
    await fetch(`${baseUrl(s)}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        clientId: "client-1",
        requestId: "req-2",
        toSessionId: "ses_a",
        question: SECRET_QUESTION,
        timeoutMs: 5000,
      }),
    })
    const ws = new WebSocket(
      `ws://127.0.0.1:${s.actualPort}/ws?token=${encodeURIComponent(TOKEN)}`,
    )
    try {
      const snapshot = await awaitFirstWsMessage(ws)
      expect(snapshot).toContain(SECRET_QUESTION.slice(0, 200))
    } finally {
      ws.close()
    }
  })
})

describe("RelayServer weak-token warning", () => {
  const logPath = (): string => join(getStateDir(), "cross-session-relay-server.log")

  test("an operator-supplied token shorter than 16 chars logs a loud warning (still accepted)", async () => {
    const s = new RelayServer({ port: 0, token: "tiny" })
    s.start()
    server = s
    const res = await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: "Bearer tiny" },
    })
    // Never warn-then-refuse: the short token still authorizes.
    expect(res.status).toBe(200)
    const log = readFileSync(logPath(), "utf8")
    expect(log).toContain("weak relay token")
    // The warning must never carry the token value itself.
    expect(log).not.toContain("tiny")
  })

  test("a 32-char operator token does not trigger the warning", async () => {
    const s = new RelayServer({ port: 0, token: "a".repeat(32) })
    s.start()
    server = s
    await graceWindowForLog()
    const log = readFileSync(logPath(), "utf8")
    expect(log).not.toContain("weak relay token")
  })

  test("a generated token does not trigger the warning", async () => {
    // No token option and no RELAY_TOKEN env: the server generates a
    // 256-bit token (beforeEach cleared the env vars).
    const s = new RelayServer({ port: 0 })
    s.start()
    server = s
    await graceWindowForLog()
    const log = readFileSync(logPath(), "utf8")
    expect(log).not.toContain("weak relay token")
  })

  /** The warning is emitted synchronously during start(); a short settle
   *  keeps the negative assertions from racing the file append. */
  async function graceWindowForLog(): Promise<void> {
    const deadline = Date.now() + 250
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
  }
})

describe("RelayServer bind host", () => {
  test("defaults to the loopback interface", () => {
    const s = new RelayServer({ port: 0, token: TOKEN })
    server = s // dispose core timer via afterEach
    expect(s.host).toBe("127.0.0.1")
  })

  test("honors an explicit host option (opt-in wide bind)", () => {
    const s = new RelayServer({ port: 0, host: "0.0.0.0", token: TOKEN })
    server = s
    expect(s.host).toBe("0.0.0.0")
  })

  test("loopback bind serves authenticated requests end-to-end", async () => {
    const s = startServer()
    expect(s.host).toBe("127.0.0.1")
    const res = await fetch(`${baseUrl(s)}/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
  })
})
