import type { Server, ServerWebSocket } from "bun"
import { createHash, timingSafeEqual } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { RELAY_DEFAULT_PORT } from "../constants.ts"
import { getStateDir } from "../xdg.ts"
import {
  CORE_BROADCAST_EVENTS,
  type LogEvent,
  RelayCore,
} from "./core.ts"
import {
  isWeakRelayToken,
  MIN_RECOMMENDED_TOKEN_CHARS,
  resolveRelayToken,
} from "./token.ts"

/** Default location of the built dashboard, relative to this file: project-root/web/dist. */
const DEFAULT_STATIC_DIR = resolve(import.meta.dir, "..", "..", "web", "dist")

export interface RelayServerOptions {
  port?: number
  /** Bind interface. Defaults to loopback (127.0.0.1); a wider bind is an explicit operator decision. */
  host?: string
  /** Shared auth token; defaults to RELAY_TOKEN env or a generated 0600 token file. */
  token?: string
  /** Opt-in question previews in broadcasts/snapshot (default OFF). */
  previews?: boolean
  staticDir?: string
}

export class RelayServer {
  readonly port: number
  readonly host: string
  readonly previews: boolean
  readonly core: RelayCore
  private readonly staticDir: string
  private readonly tokenOption: string | undefined
  private token: string | null = null
  private server: Server<undefined> | null = null
  private readonly wsClients = new Set<ServerWebSocket<unknown>>()
  private serverLogPath: string | null = null
  private readonly coreListeners: Array<{
    event: string
    fn: (data: unknown) => void
  }> = []
  private readonly logListener: (evt: LogEvent) => void

  constructor(portOrOpts?: number | RelayServerOptions) {
    if (typeof portOrOpts === "number") {
      this.port = portOrOpts
      this.host = "127.0.0.1"
      this.previews = false
      this.tokenOption = undefined
      this.staticDir = DEFAULT_STATIC_DIR
    } else {
      this.port = portOrOpts?.port ?? RELAY_DEFAULT_PORT
      this.host = portOrOpts?.host ?? "127.0.0.1"
      this.previews = portOrOpts?.previews ?? false
      this.tokenOption = portOrOpts?.token
      this.staticDir = portOrOpts?.staticDir ?? DEFAULT_STATIC_DIR
    }
    this.core = new RelayCore({ previews: this.previews })
    this.logListener = (evt: LogEvent) => this.writeLog(evt)
    this.core.on("log", this.logListener)
  }

  get peersByDevice(): Array<{ device: string; count: number }> {
    return this.core.peersByDevice
  }

  get connectedClients(): number {
    return this.core.connectedClients
  }

  get clientDetails(): Array<{ ip: string; sessions: string[] }> {
    return this.core.clientDetails
  }

  /** The port actually bound (differs from `port` when started on port 0). */
  get actualPort(): number {
    return this.server?.port ?? this.port
  }

  start(): void {
    if (this.server) return
    this.token = resolveRelayToken({ token: this.tokenOption })
    // Weak-token warning (W1-U2c item G): a short operator-supplied token is
    // warned about loudly at startup but still accepted (never
    // warn-then-refuse). Generated tokens are 256-bit and never qualify.
    // The token value itself is never logged.
    if (isWeakRelayToken(this.token)) {
      this.writeLog({
        level: "warn",
        tag: "relay",
        message: `weak relay token in effect (shorter than ${MIN_RECOMMENDED_TOKEN_CHARS} chars); generated tokens are 256-bit; prefer the RELAY_TOKEN env or the 0600 token file over a short shared secret`,
      })
    }
    this.subscribeCoreEvents()
    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch: (req, srv) => this.handleRequest(req, srv),
      websocket: {
        open: (ws) => this.onWsOpen(ws),
        close: (ws) => this.onWsClose(ws),
        message: () => {
          /* dashboard is read-only */
        },
      },
    })
    this.writeLog({
      level: "info",
      tag: "relay",
      message: `listening on ${this.host}:${this.port} (auth required on /api/*, /stats, /ws)`,
    })
  }

  stop(): void {
    if (!this.server) {
      this.core.dispose()
      return
    }
    for (const ws of this.wsClients) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.wsClients.clear()
    this.unsubscribeCoreEvents()
    this.server.stop(true)
    this.server = null
    this.core.dispose()
    this.writeLog({ level: "info", tag: "relay", message: "stopped" })
  }

  private subscribeCoreEvents(): void {
    for (const event of CORE_BROADCAST_EVENTS) {
      const fn = (data: unknown) => this.broadcast({ type: event, data })
      this.core.on(event, fn)
      this.coreListeners.push({ event, fn })
    }
  }

  private unsubscribeCoreEvents(): void {
    for (const { event, fn } of this.coreListeners) {
      this.core.off(event, fn)
    }
    this.coreListeners.length = 0
  }

  private broadcast(event: { type: string; data: unknown }): void {
    let json: string
    try {
      json = JSON.stringify(event)
    } catch {
      return
    }
    for (const ws of this.wsClients) {
      try {
        ws.send(json)
      } catch {
        /* client gone; will be cleaned by close handler */
      }
    }
  }

  private onWsOpen(ws: ServerWebSocket<unknown>): void {
    this.wsClients.add(ws)
    try {
      ws.send(
        JSON.stringify({ type: "snapshot", data: this.core.getSnapshot() }),
      )
    } catch {
      /* ignore */
    }
  }

  private onWsClose(ws: ServerWebSocket<unknown>): void {
    this.wsClients.delete(ws)
  }

  private writeLog(evt: LogEvent): void {
    if (!this.serverLogPath) {
      this.serverLogPath = join(getStateDir(), "cross-session-relay-server.log")
      try {
        mkdirSync(dirname(this.serverLogPath), { recursive: true })
      } catch {
        /* ignore */
      }
    }
    try {
      appendFileSync(
        this.serverLogPath,
        `${new Date().toISOString()} [${evt.level}] [${evt.tag}] ${evt.message}\n`,
      )
    } catch {
      /* ignore */
    }
  }

  private async handleRequest(
    req: Request,
    server: Server<undefined>,
  ): Promise<Response | undefined> {
    try {
      const url = new URL(req.url)
      const path = url.pathname

      // Auth gate (security remediation 2026-11): every data surface
      // (/api/*, /stats, /ws) requires the shared token, via the
      // Authorization header or the token query param (WS clients in
      // browsers cannot set headers). Static dashboard assets carry no
      // data and stay reachable.
      if (
        path === "/ws" ||
        path === "/stats" ||
        path.startsWith("/api/")
      ) {
        if (!this.isAuthorized(req, url)) {
          this.writeLog({
            level: "warn",
            tag: "relay",
            message: `rejected ${req.method} ${path} (unauthorized)`,
          })
          return Response.json(
            { error: "unauthorized" },
            {
              status: 401,
              headers: { "WWW-Authenticate": "Bearer" },
            },
          )
        }
      }

      if (path === "/ws") {
        if (server.upgrade(req)) return undefined
        return new Response("Expected WebSocket upgrade", { status: 400 })
      }

      if (path === "/stats" && req.method === "GET") {
        return Response.json({ peers: this.core.peersByDevice })
      }

      if (path === "/api/poll" && req.method === "GET") {
        const clientId = url.searchParams.get("clientId")
        if (!clientId) {
          return Response.json(
            { error: "clientId required" },
            { status: 400 },
          )
        }
        this.core.touchClient(clientId, this.tryGetClientIp(req, server))
        const messages = this.core.poll(clientId)
        return Response.json({ messages })
      }

      if (path.startsWith("/api/")) {
        return await this.handleApiPost(req, server, path)
      }

      return await this.serveStatic(path)
    } catch (err) {
      this.writeLog({
        level: "error",
        tag: "relay",
        message: `request error: ${(err as Error).message}`,
      })
      return Response.json(
        { error: `internal error: ${(err as Error).message}` },
        { status: 500 },
      )
    }
  }

  private async handleApiPost(
    req: Request,
    server: Server<undefined>,
    path: string,
  ): Promise<Response> {
    if (req.method !== "POST") {
      this.writeLog({
        level: "warn",
        tag: "relay",
        message: `rejected ${req.method} ${path} (method not allowed)`,
      })
      return Response.json(
        { error: "method not allowed" },
        { status: 405 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      this.writeLog({
        level: "warn",
        tag: "relay",
        message: `rejected POST ${path} (invalid JSON)`,
      })
      return Response.json(
        { error: "invalid JSON body" },
        { status: 400 },
      )
    }

    const clientId = body.clientId as string | undefined
    if (!clientId) {
      this.writeLog({
        level: "warn",
        tag: "relay",
        message: `rejected POST ${path} (missing clientId)`,
      })
      return Response.json(
        { error: "clientId required" },
        { status: 400 },
      )
    }

    this.core.touchClient(clientId, this.tryGetClientIp(req, server))

    switch (path) {
      case "/api/register": {
        const entry = this.core.register(clientId, {
          sessionId: body.sessionId as string,
          summary: body.summary as string,
          directory: body.directory as string,
          projectId: body.projectId as string,
          serverUrl: body.serverUrl as string | undefined,
          daemonId: body.daemonId as string | undefined,
          deviceName: body.deviceName as string | undefined,
        })
        return Response.json({
          type: "registered",
          sessionId: entry.sessionId,
          entry,
        })
      }
      case "/api/unregister": {
        const sessionId = body.sessionId as string
        const removed = this.core.unregister(clientId, sessionId)
        return Response.json({
          type: "unregistered",
          sessionId,
          removed,
        })
      }
      case "/api/list": {
        const requestId = body.requestId as string
        const entries = this.core.list()
        return Response.json({ type: "sessions", requestId, entries })
      }
      case "/api/lookup": {
        const requestId = body.requestId as string
        const sessionId = body.sessionId as string
        const entry = this.core.lookup(sessionId)
        return Response.json({ type: "looked-up", requestId, entry })
      }
      case "/api/ask": {
        const result = this.core.ask(clientId, {
          requestId: body.requestId as string,
          toSessionId: body.toSessionId as string,
          question: body.question as string,
          timeoutMs: body.timeoutMs as number,
        })
        return Response.json(result)
      }
      case "/api/reply": {
        this.core.reply({
          requestId: body.requestId as string,
          reply: body.reply as string | undefined,
          error: body.error as string | undefined,
        })
        return Response.json({ ok: true })
      }
      default:
        this.writeLog({
          level: "warn",
          tag: "relay",
          message: `404 POST ${path} from ${clientId.slice(0, 8)}`,
        })
        return Response.json({ error: "not found" }, { status: 404 })
    }
  }

  private tryGetClientIp(
    req: Request,
    server: Server<undefined>,
  ): string | undefined {
    try {
      const addr = server.requestIP(req)
      return addr?.address
    } catch {
      return undefined
    }
  }

  /**
   * Timing-safe shared-token check. Accepts the token via the Authorization
   * header (Bearer scheme, case-insensitive per RFC 7235 so bearer/Bearer/
   * BEARER all validate; W1-U2c item E) or the token query param. The
   * comparison hashes both sides so digest length never leaks token length.
   */
  private isAuthorized(req: Request, url: URL): boolean {
    if (!this.token) return false
    const queryCandidate = (url.searchParams.get("token") ?? "").trim()
    const header = req.headers.get("authorization")
    let candidate: string
    if (header !== null && header.includes(" ")) {
      const schemeEnd = header.indexOf(" ")
      const isBearer =
        header.slice(0, schemeEnd).toLowerCase() === "bearer"
      candidate = isBearer
        ? header.slice(schemeEnd + 1).trim()
        : queryCandidate
    } else {
      candidate = queryCandidate
    }
    if (candidate.length === 0) return false
    const candidateDigest = createHash("sha256").update(candidate).digest()
    const tokenDigest = createHash("sha256").update(this.token).digest()
    return timingSafeEqual(candidateDigest, tokenDigest)
  }

  private async serveStatic(path: string): Promise<Response> {
    if (!existsSync(this.staticDir)) {
      return this.dashboardNotBuiltResponse(path)
    }

    const rel = path === "/" ? "/index.html" : path
    const requestedPath = resolve(this.staticDir, `.${rel}`)
    if (
      requestedPath !== this.staticDir &&
      !requestedPath.startsWith(this.staticDir + "/")
    ) {
      return new Response("Not found", { status: 404 })
    }

    const file = Bun.file(requestedPath)
    if (await file.exists()) {
      return new Response(file)
    }

    const indexPath = join(this.staticDir, "index.html")
    const indexFile = Bun.file(indexPath)
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return this.dashboardNotBuiltResponse(path)
  }

  private dashboardNotBuiltResponse(path: string): Response {
    if (path !== "/") {
      return new Response("Not found", { status: 404 })
    }
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cross-Session Relay</title>
  <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5}code{background:#f4f4f4;padding:.15rem .4rem;border-radius:3px}</style>
</head>
<body>
  <h1>Dashboard not built yet</h1>
  <p>Run: <code>bun run dashboard:build</code></p>
  <p>Server is running on port <strong>${this.port}</strong>. API endpoints under <code>/api/*</code> and the WebSocket at <code>/ws</code> are functional.</p>
</body>
</html>`
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
}
