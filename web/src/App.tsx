import { createSignal, onCleanup, onMount } from "solid-js"
import { createRelayConnection } from "./ws"
import type { ActivityEntry, ClientInfo, DashboardEvent, PendingAskInfo, ServerActivityEntry, SessionInfo } from "./types"
import { Overview } from "./components/Overview"
import { SessionsPanel } from "./components/SessionsPanel"
import { MessageFlow } from "./components/MessageFlow"
import { ClientsPanel } from "./components/ClientsPanel"

const MAX_ACTIVITY = 200

const RELAY_TOKEN_STORAGE_KEY = "csm-relay-token"

/**
 * Shared relay token for the token-authed /ws endpoint (security
 * remediation 2026-11). Resolved once per dashboard load: from
 * localStorage, else the operator is prompted; the value is cached so a
 * reconnect loop never re-prompts. Empty input means "no token" and the
 * server will answer 401 until a token is supplied on a reload.
 */
function resolveRelayToken(): string | undefined {
  const stored = localStorage.getItem(RELAY_TOKEN_STORAGE_KEY)?.trim()
  if (stored) return stored
  const entered = window.prompt("Relay shared token:")?.trim()
  if (!entered) return undefined
  localStorage.setItem(RELAY_TOKEN_STORAGE_KEY, entered)
  return entered
}

export default function App() {
  const [connected, setConnected] = createSignal(false)
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [clients, setClients] = createSignal<ClientInfo[]>([])
  const [pendingAsks, setPendingAsks] = createSignal<PendingAskInfo[]>([])
  const [activity, setActivity] = createSignal<ActivityEntry[]>([])

  function handleEvent(event: DashboardEvent) {
    switch (event.type) {
      case "snapshot":
        setSessions(event.data.sessions)
        setClients(event.data.clients)
        setPendingAsks(event.data.pendingAsks)
        setActivity(event.data.activity.map(serverActivityToLocal))
        break

      case "session:registered":
        setSessions((prev) => {
          const filtered = prev.filter((s) => s.sessionId !== event.data.entry.sessionId)
          return [event.data.entry, ...filtered]
        })
        pushActivity(event)
        break

      case "session:unregistered":
        setSessions((prev) => prev.filter((s) => s.sessionId !== event.data.sessionId))
        pushActivity(event)
        break

      case "client:connected":
        setClients((prev) => {
          const filtered = prev.filter((c) => c.clientId !== event.data.clientId)
          return [...filtered, { clientId: event.data.clientId, ip: event.data.ip, lastSeen: Date.now(), sessions: [] }]
        })
        pushActivity(event)
        break

      case "client:disconnected":
        setClients((prev) => prev.filter((c) => c.clientId !== event.data.clientId))
        pushActivity(event)
        break

      case "ask:created":
        setPendingAsks((prev) => [
          ...prev,
          {
            requestId: event.data.requestId,
            callerClientId: "",
            fromSessionId: event.data.fromSessionId,
            targetSessionId: event.data.toSessionId,
            questionPreview: event.data.questionPreview,
            timeoutMs: event.data.timeoutMs,
            createdAt: event.data.createdAt,
          },
        ])
        pushActivity(event)
        break

      case "ask:replied":
      case "ask:error":
      case "ask:timeout":
        setPendingAsks((prev) => prev.filter((a) => a.requestId !== event.data.requestId))
        pushActivity(event)
        break
    }
  }

  function pushActivity(event: DashboardEvent) {
    if (event.type === "snapshot") return
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      type: event.type,
      timestamp: Date.now(),
      data: event.data as Record<string, unknown>,
    }
    setActivity((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY))
  }

  function serverActivityToLocal(sa: ServerActivityEntry): ActivityEntry {
    return {
      id: crypto.randomUUID(),
      type: sa.kind as ActivityEntry["type"],
      timestamp: sa.at,
      data: (sa.data ?? {}) as Record<string, unknown>,
    }
  }

  onMount(() => {
    const conn = createRelayConnection({
      onEvent: handleEvent,
      onStatus: setConnected,
      token: resolveRelayToken(),
    })
    onCleanup(() => conn.dispose())
  })

  return (
    <div class="dashboard">
      <header class="header">
        <h1>中继服务控制台</h1>
        <span class={`status ${connected() ? "connected" : "disconnected"}`}>
          {connected() ? "已连接" : "未连接"}
        </span>
      </header>
      <Overview sessions={sessions()} clients={clients()} pendingAsks={pendingAsks()} />
      <div class="panels">
        <SessionsPanel sessions={sessions()} />
        <MessageFlow activity={activity()} pendingAsks={pendingAsks()} />
      </div>
      <ClientsPanel clients={clients()} />
    </div>
  )
}
