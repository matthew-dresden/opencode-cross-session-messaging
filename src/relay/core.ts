import { EventEmitter } from "node:events"
import { STALE_ENTRY_TTL_MS } from "../constants.ts"
import type { RegistryEntry } from "../types.ts"
import type { ServerMessage } from "./protocol.ts"

/** Client considered offline if not seen within this many ms. */
export const CLIENT_STALE_MS = 30_000
/** How often the stale-client sweeper runs. */
export const CLEANUP_INTERVAL_MS = 10_000
/** Max entries kept in the recent-activity ring buffer. */
export const MAX_ACTIVITY_ENTRIES = 200
/** Max chars of a question preserved in the ask:created event. */
export const QUESTION_PREVIEW_LEN = 200

interface PendingAsk {
  callerClientId: string
  targetSessionId: string
  fromSessionId: string
  createdAt: number
  timeoutMs: number
}

export interface PendingAskInfo extends PendingAsk {
  requestId: string
}

export interface ClientInfo {
  clientId: string
  ip: string
  lastSeen: number
  sessions: string[]
}

export interface ActivityEntry {
  at: number
  kind: string
  data: unknown
}

export interface CoreSnapshot {
  sessions: RegistryEntry[]
  clients: ClientInfo[]
  pendingAsks: PendingAskInfo[]
  activity: ActivityEntry[]
  stats: {
    sessionCount: number
    connectedClients: number
    pendingAskCount: number
  }
}

export type LogLevel = "info" | "warn" | "error" | "debug"

export interface LogEvent {
  level: LogLevel
  tag: string
  message: string
}

export interface SessionRegisteredEvent {
  sessionId: string
  entry: RegistryEntry
  clientId: string
}

export interface SessionUnregisteredEvent {
  sessionId: string
  existed: boolean
}

export interface ClientConnectedEvent {
  clientId: string
  ip: string
}

export interface ClientDisconnectedEvent {
  clientId: string
  sessionCount: number
}

export interface AskCreatedEvent {
  requestId: string
  fromSessionId: string
  toSessionId: string
  questionPreview: string
  timeoutMs: number
  createdAt: number
}

export interface AskRepliedEvent {
  requestId: string
  replyLen: number
  error?: string
  durationMs: number
}

export interface AskTimeoutEvent {
  requestId: string
  targetSessionId: string
}

/** Business-logic core for the relay. Owns all state and emits events on
 *  every mutation. The HTTP/WebSocket layer subscribes to broadcast to
 *  dashboards; the CLI subscribes to write log lines.
 *
 *  Privacy default (security remediation 2026-11): question previews are OFF.
 *  Broadcast events and the WS snapshot carry event type + ids + timing
 *  only; question content never leaves the ask/reply delivery path unless
 *  the operator explicitly opts in with `previews: true` (CLI --previews). */
export class RelayCore extends EventEmitter {
  private readonly previews: boolean
  private readonly sessions = new Map<string, RegistryEntry>()
  private readonly sessionToClient = new Map<string, string>()
  private readonly clientToSessions = new Map<string, Set<string>>()
  private readonly clientLastSeen = new Map<string, number>()
  private readonly clientIps = new Map<string, string>()
  private readonly clientQueues = new Map<string, ServerMessage[]>()
  private readonly pendingAsks = new Map<string, PendingAsk>()
  private _activity: ActivityEntry[] = []
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: { previews?: boolean }) {
    super()
    this.previews = opts?.previews ?? false
    this.cleanupTimer = setInterval(
      () => this.cleanupStaleClients(),
      CLEANUP_INTERVAL_MS,
    )
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.sessions.clear()
    this.sessionToClient.clear()
    this.clientToSessions.clear()
    this.clientLastSeen.clear()
    this.clientIps.clear()
    this.clientQueues.clear()
    this.pendingAsks.clear()
    this._activity = []
    this.removeAllListeners()
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  get connectedClients(): number {
    const cutoff = Date.now() - CLIENT_STALE_MS
    let count = 0
    for (const ts of this.clientLastSeen.values()) {
      if (ts >= cutoff) count++
    }
    return count
  }

  get allSessions(): RegistryEntry[] {
    return [...this.sessions.values()]
  }

  get allClients(): ClientInfo[] {
    return [...this.clientLastSeen.entries()].map(([clientId, lastSeen]) => ({
      clientId,
      ip: this.clientIps.get(clientId) ?? "unknown",
      lastSeen,
      sessions: [...(this.clientToSessions.get(clientId) ?? [])],
    }))
  }

  get allPendingAsks(): PendingAskInfo[] {
    return [...this.pendingAsks.entries()].map(([requestId, p]) => ({
      requestId,
      ...p,
    }))
  }

  get recentActivity(): ActivityEntry[] {
    return [...this._activity]
  }

  get peersByDevice(): Array<{ device: string; count: number }> {
    const counts = new Map<string, number>()
    for (const entry of this.sessions.values()) {
      const device = entry.deviceName ?? "unknown"
      counts.set(device, (counts.get(device) ?? 0) + 1)
    }
    return [...counts.entries()].map(([device, count]) => ({ device, count }))
  }

  get clientDetails(): Array<{ ip: string; sessions: string[] }> {
    const cutoff = Date.now() - CLIENT_STALE_MS
    const details: Array<{ ip: string; sessions: string[] }> = []
    for (const [cid, ts] of this.clientLastSeen) {
      if (ts < cutoff) continue
      const sids = this.clientToSessions.get(cid)
      details.push({
        ip: this.clientIps.get(cid) ?? "unknown",
        sessions: sids ? [...sids] : [],
      })
    }
    return details
  }

  getSnapshot(): CoreSnapshot {
    return {
      sessions: this.allSessions,
      clients: this.allClients,
      pendingAsks: this.allPendingAsks,
      activity: this.recentActivity,
      stats: {
        sessionCount: this.sessionCount,
        connectedClients: this.connectedClients,
        pendingAskCount: this.pendingAsks.size,
      },
    }
  }

  touchClient(clientId: string, ip?: string): void {
    const isNew = !this.clientLastSeen.has(clientId)
    this.clientLastSeen.set(clientId, Date.now())
    if (ip !== undefined) this.clientIps.set(clientId, ip)
    if (!this.clientToSessions.has(clientId)) {
      this.clientToSessions.set(clientId, new Set())
    }
    if (!this.clientQueues.has(clientId)) {
      this.clientQueues.set(clientId, [])
    }
    if (isNew) {
      const resolvedIp = this.clientIps.get(clientId) ?? "unknown"
      this.emitEvent("client:connected", {
        clientId,
        ip: resolvedIp,
      } satisfies ClientConnectedEvent)
      this.log(
        "info",
        "relay",
        `new client ${clientId.slice(0, 8)} from ${resolvedIp} (total=${this.clientLastSeen.size})`,
      )
    }
  }

  register(
    clientId: string,
    data: {
      sessionId: string
      summary: string
      directory: string
      projectId: string
      serverUrl?: string
      daemonId?: string
      deviceName?: string
    },
  ): RegistryEntry {
    const now = Date.now()
    const existing = this.sessions.get(data.sessionId)
    const entry: RegistryEntry = {
      sessionId: data.sessionId,
      summary: data.summary,
      directory: data.directory,
      projectId: data.projectId,
      serverUrl: data.serverUrl,
      daemonId: data.daemonId,
      deviceName: data.deviceName,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }

    const oldOwner = this.sessionToClient.get(data.sessionId)
    if (oldOwner && oldOwner !== clientId) {
      this.clientToSessions.get(oldOwner)?.delete(data.sessionId)
      this.log(
        "info",
        "relay",
        `register: session ${data.sessionId} moved from client ${oldOwner.slice(0, 8)} to ${clientId.slice(0, 8)}`,
      )
    }

    this.sessions.set(data.sessionId, entry)
    this.sessionToClient.set(data.sessionId, clientId)
    const owned = this.clientToSessions.get(clientId) ?? new Set<string>()
    owned.add(data.sessionId)
    this.clientToSessions.set(clientId, owned)

    this.emitEvent("session:registered", {
      sessionId: data.sessionId,
      entry,
      clientId,
    } satisfies SessionRegisteredEvent)
    this.log(
      "info",
      "relay",
      `registered ${data.sessionId} (client=${clientId.slice(0, 8)}, device=${entry.deviceName ?? "?"}, sessions=${this.sessions.size})`,
    )
    return entry
  }

  unregister(clientId: string, sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId)
    this.sessionToClient.delete(sessionId)
    this.clientToSessions.get(clientId)?.delete(sessionId)
    this.emitEvent("session:unregistered", {
      sessionId,
      existed,
    } satisfies SessionUnregisteredEvent)
    this.log(
      "info",
      "relay",
      `unregistered ${sessionId} (client=${clientId.slice(0, 8)}, existed=${existed}, sessions=${this.sessions.size})`,
    )
    return existed
  }

  list(): RegistryEntry[] {
    const cutoff = Date.now() - STALE_ENTRY_TTL_MS
    return [...this.sessions.values()]
      .filter((e) => e.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  lookup(sessionId: string): RegistryEntry | null {
    return this.sessions.get(sessionId) ?? null
  }

  ask(
    callerClientId: string,
    data: {
      requestId: string
      toSessionId: string
      question: string
      timeoutMs: number
    },
  ): { ok: boolean; error?: string } {
    const targetClientId = this.sessionToClient.get(data.toSessionId)
    if (!targetClientId) {
      this.log(
        "warn",
        "relay",
        `ask ${data.requestId.slice(0, 8)} from ${callerClientId.slice(0, 8)} → target ${data.toSessionId} NOT FOUND`,
      )
      return {
        ok: false,
        error: `Target session ${data.toSessionId} not found`,
      }
    }

    const callerSessions = this.clientToSessions.get(callerClientId)
    // Ask attribution (security remediation 2026-11): the caller's own
    // registered session identifies the ask. An unregistered (anonymous)
    // caller is attributed to the target session instead of a literal
    // "unknown", so broadcast events and snapshots always carry a real
    // session id.
    const callerSessionId = callerSessions?.values().next().value
    const fromSessionId: string = callerSessionId ?? data.toSessionId
    const createdAt = Date.now()

    this.pendingAsks.set(data.requestId, {
      callerClientId,
      targetSessionId: data.toSessionId,
      fromSessionId,
      createdAt,
      timeoutMs: data.timeoutMs,
    })

    this.enqueue(targetClientId, {
      type: "inbound",
      requestId: data.requestId,
      fromSessionId,
      toSessionId: data.toSessionId,
      question: data.question,
      timeoutMs: data.timeoutMs,
    })

    this.emitEvent("ask:created", {
      requestId: data.requestId,
      fromSessionId,
      toSessionId: data.toSessionId,
      questionPreview: this.previews
        ? data.question.slice(0, QUESTION_PREVIEW_LEN)
        : "",
      timeoutMs: data.timeoutMs,
      createdAt,
    } satisfies AskCreatedEvent)
    this.log(
      "info",
      "relay",
      `ask ${data.requestId.slice(0, 8)}: ${fromSessionId} → ${data.toSessionId} (target-client=${targetClientId.slice(0, 8)}, qLen=${data.question.length}, timeout=${data.timeoutMs}ms)`,
    )
    return { ok: true }
  }

  reply(data: {
    requestId: string
    reply?: string
    error?: string
  }): void {
    const pending = this.pendingAsks.get(data.requestId)
    if (!pending) {
      this.log(
        "warn",
        "relay",
        `reply ${data.requestId.slice(0, 8)} → no pending ask (stale/duplicate)`,
      )
      return
    }
    const durationMs = Date.now() - pending.createdAt
    this.pendingAsks.delete(data.requestId)
    this.enqueue(pending.callerClientId, {
      type: "reply",
      requestId: data.requestId,
      reply: data.reply,
      error: data.error,
    })

    this.emitEvent("ask:replied", {
      requestId: data.requestId,
      replyLen: data.reply?.length ?? 0,
      error: data.error,
      durationMs,
    } satisfies AskRepliedEvent)
    this.log(
      "info",
      "relay",
      `reply ${data.requestId.slice(0, 8)} → queued to ${pending.callerClientId.slice(0, 8)} (replyLen=${data.reply?.length ?? 0}, error=${data.error ?? "none"}, dur=${durationMs}ms)`,
    )
  }

  poll(clientId: string): ServerMessage[] {
    const queue = this.clientQueues.get(clientId)
    if (!queue || queue.length === 0) return []
    const messages = [...queue]
    queue.length = 0
    this.log(
      "debug",
      "relay",
      `poll ${clientId.slice(0, 8)} → ${messages.length} msg(s): [${messages.map((m) => m.type).join(", ")}]`,
    )
    return messages
  }

  cleanupStaleClients(): void {
    const cutoff = Date.now() - CLIENT_STALE_MS
    for (const [clientId, lastSeen] of this.clientLastSeen) {
      if (lastSeen >= cutoff) continue

      const owned = this.clientToSessions.get(clientId) ?? new Set<string>()
      for (const sid of owned) {
        const existed = this.sessions.delete(sid)
        this.sessionToClient.delete(sid)
        this.emitEvent("session:unregistered", {
          sessionId: sid,
          existed,
        } satisfies SessionUnregisteredEvent)
      }

      for (const [reqId, pending] of this.pendingAsks) {
        if (pending.callerClientId === clientId) {
          this.pendingAsks.delete(reqId)
          this.emitEvent("ask:timeout", {
            requestId: reqId,
            targetSessionId: pending.targetSessionId,
          } satisfies AskTimeoutEvent)
        } else if (owned.has(pending.targetSessionId)) {
          this.enqueue(pending.callerClientId, {
            type: "reply",
            requestId: reqId,
            error: `Target session ${pending.targetSessionId} disconnected`,
          })
          this.pendingAsks.delete(reqId)
          this.emitEvent("ask:timeout", {
            requestId: reqId,
            targetSessionId: pending.targetSessionId,
          } satisfies AskTimeoutEvent)
        }
      }

      this.clientToSessions.delete(clientId)
      this.clientLastSeen.delete(clientId)
      this.clientIps.delete(clientId)
      this.clientQueues.delete(clientId)

      this.emitEvent("client:disconnected", {
        clientId,
        sessionCount: owned.size,
      } satisfies ClientDisconnectedEvent)
      this.log(
        "info",
        "relay",
        `cleanup: stale client ${clientId.slice(0, 8)} removed (${owned.size} sessions, remaining clients=${this.clientLastSeen.size})`,
      )
    }
  }

  private enqueue(clientId: string, msg: ServerMessage): void {
    let queue = this.clientQueues.get(clientId)
    if (!queue) {
      queue = []
      this.clientQueues.set(clientId, queue)
    }
    queue.push(msg)
  }

  private emitEvent(kind: string, data: unknown): void {
    this._activity.push({ at: Date.now(), kind, data })
    if (this._activity.length > MAX_ACTIVITY_ENTRIES) {
      this._activity.splice(0, this._activity.length - MAX_ACTIVITY_ENTRIES)
    }
    this.emit(kind, data)
  }

  private log(level: LogLevel, tag: string, message: string): void {
    this.emit("log", { level, tag, message } satisfies LogEvent)
  }
}

/** All broadcast event names emitted by RelayCore (excluding "log"). */
export const CORE_BROADCAST_EVENTS = [
  "session:registered",
  "session:unregistered",
  "client:connected",
  "client:disconnected",
  "ask:created",
  "ask:replied",
  "ask:timeout",
] as const
