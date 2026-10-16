/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"
import { PLUGIN_ID, RELAY_DEFAULT_PORT } from "./src/constants.ts"
import { listEntries, removeEntry, upsertEntry } from "./src/registry.ts"
import type { RegistryEntry } from "./src/types.ts"
import type { RelayServer } from "./src/relay/server.ts"
import {
  clearRelayUrl,
  getRelayHistory,
  getRelayUrl,
  writeRelayUrl,
} from "./src/config.ts"

/**
 * V2 CLI plugin (ported from the V1 experimental TUI plugin API, story 2.4).
 *
 * Import surface: `@opencode/plugin/tui` — the V2 CLI host resolves this
 * specifier at runtime (verified in the opencode 2.0.30 binary, which aliases
 * it to its bundled implementation), so no runtime dependency is required;
 * `@opencode/plugin` is a devDependency for typechecking only.
 *
 * V1 → V2 API mapping applied here (full table in the port summary):
 * - `TuiPluginModule { id, tui(api) }` → `Plugin.define({ id, setup(context) })`
 * - `api.lifecycle.onDispose(fn)` → cleanup function returned from setup
 * - `api.command.register(...)` → `context.keymap.layer(...)` palette/slash commands
 * - `api.slots.register({ slots: { sidebar_title } })` → `context.ui.slot({ append: "sidebar.content" })`
 *   (V1 `sidebar_title` does not exist in V2; `sidebar.content` is the nearest slot)
 * - `api.ui.toast({ variant, message })` → `context.ui.toast.show({ message, variant })`
 * - `api.ui.dialog.setSize/replace` + `<api.ui.DialogPrompt/>`/`<api.ui.DialogSelect/>`
 *   → promise-based `context.ui.dialog.prompt/select` and `dialog.set` + `dialog.show`
 *   for custom JSX panels
 * - `api.route.current` (`name`, `params.sessionID`) → `context.ui.router.current()` (`type`, `sessionID`)
 * - `api.state.session.get` → `context.data.session.get`
 * - `api.state.path.directory` / `.worktree` → `context.location.directory` /
 *   `context.data.session.get(id).projectID` (LocationRef carries no project
 *   metadata; V1 recorded the worktree path as projectId — V2 records the
 *   real project id)
 * - theme tokens: `theme.text`→`theme.text.base`, `theme.textMuted`→`theme.text.muted`,
 *   `theme.primary`→`theme.text.action.primary.focused`, `theme.success`→`theme.text.feedback.success.base`
 */

let activeRelay: RelayServer | null = null

interface PeerGroup {
  device: string
  count: number
}

const [relayInfo, setRelayInfo] = createSignal<{
  port: number
  localIp: string
  peers: PeerGroup[]
} | null>(null)

const [clientInfo, setClientInfo] = createSignal<{
  url: string
  peers: PeerGroup[]
} | null>(null)

let relayPollTimer: ReturnType<typeof setInterval> | null = null
let clientPollTimer: ReturnType<typeof setInterval> | null = null

function startRelayPolling(): void {
  if (relayPollTimer) return
  updateRelayInfo()
  relayPollTimer = setInterval(updateRelayInfo, 2_000)
}

function stopRelayPolling(): void {
  if (relayPollTimer) {
    clearInterval(relayPollTimer)
    relayPollTimer = null
  }
  setRelayInfo(null)
}

function updateRelayInfo(): void {
  if (!activeRelay) {
    setRelayInfo(null)
    return
  }
  setRelayInfo({
    port: activeRelay.port,
    localIp: getLocalIp(),
    peers: activeRelay.peersByDevice,
  })
}

function startClientPolling(): void {
  if (clientPollTimer) return
  updateClientInfo()
  clientPollTimer = setInterval(updateClientInfo, 3_000)
}

function stopClientPolling(): void {
  if (clientPollTimer) {
    clearInterval(clientPollTimer)
    clientPollTimer = null
  }
  setClientInfo(null)
}

function updateClientInfo(): void {
  const url = getRelayUrl()
  if (!url) {
    setClientInfo(null)
    return
  }
  fetch(`${url}/stats`)
    .then((res) => res.json() as Promise<{ peers: PeerGroup[] }>)
    .then((data) => setClientInfo({ url, peers: data.peers }))
    .catch(() => setClientInfo({ url, peers: [] }))
}

function getLocalIp(): string {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address
    }
  }
  return "0.0.0.0"
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

function copyToClipboard(text: string): boolean {
  try {
    const cmd =
      process.platform === "darwin"
        ? "pbcopy"
        : process.platform === "linux"
          ? "xclip -selection clipboard"
          : process.platform === "win32"
            ? "clip"
            : undefined
    if (!cmd) return false
    execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

function formatSessionInfo(entry: RegistryEntry): string {
  return [
    `Use the ask_session tool to communicate with this peer session:`,
    ``,
    `- Session ID: ${entry.sessionId}`,
    `- Summary: ${entry.summary}`,
    `- Directory: ${entry.directory}`,
    `- Project: ${entry.projectId}`,
    entry.deviceName ? `- Device: ${entry.deviceName}` : "",
    ``,
    `ask_session(sessionId="${entry.sessionId}", question="<your self-contained question here>")`,
    ``,
    `IMPORTANT: The target session CANNOT see your conversation history.`,
    `Include ALL necessary context (background, code snippets, constraints) in the question text itself.`,
  ]
    .filter(Boolean)
    .join("\n")
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function shortDir(dir: string): string {
  const parts = dir.split("/")
  return parts.length <= 3 ? dir : `…/${parts.slice(-2).join("/")}`
}

const VIEWPORT_ROWS = 40
const EXPANDED_EXTRA = 7
const LINE_WIDTH = 72

interface VLine {
  text: string
  style: "selected" | "normal" | "muted"
}

async function deleteSession(sessionId: string): Promise<void> {
  const relayUrl = getRelayUrl()
  if (relayUrl) {
    const res = await fetch(`${relayUrl}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: `tui-delete-${randomUUID().slice(0, 8)}`,
        sessionId,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }
  await removeEntry(sessionId)
}

function PeersPanel(props: {
  entries: RegistryEntry[]
  selfId?: string
}) {
  // V2: plugin context comes from usePlugin() inside host-rendered JSX
  // instead of the V1 `api` prop.
  const context = usePlugin()
  const theme = context.theme
  const localDevice = hostname()
  const [entries, setEntries] = createSignal(props.entries)
  const [tabIndex, setTabIndex] = createSignal(0)
  const [rowIndex, setRowIndex] = createSignal(0)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(
    null,
  )

  function toggleExpand(sessionId: string, force?: boolean): void {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (force ?? !next.has(sessionId)) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  function devices() {
    const seen = new Map<string, RegistryEntry[]>()
    for (const e of entries()) {
      const dev = e.deviceName ?? "unknown"
      const arr = seen.get(dev)
      if (arr) arr.push(e)
      else seen.set(dev, [e])
    }
    return [...seen.entries()].map(([name, items]) => ({ name, items }))
  }

  function currentTab() {
    const devs = devices()
    return devs[tabIndex()] ?? devs[0]
  }

  function switchTab(delta: number): void {
    const devs = devices()
    if (devs.length === 0) return
    setTabIndex(
      (i) => (((i + delta) % devs.length) + devs.length) % devs.length,
    )
    setRowIndex(0)
    setScrollTop(0)
    setConfirmingDelete(null)
  }

  function moveRow(delta: number): void {
    const tab = currentTab()
    if (!tab) return
    setConfirmingDelete(null)
    setRowIndex((i) => Math.max(0, Math.min(tab.items.length - 1, i + delta)))
  }

  function buildLines(): VLine[] {
    const tab = currentTab()
    if (!tab) return []
    const lines: VLine[] = []
    for (let i = 0; i < tab.items.length; i++) {
      const e = tab.items[i]
      const sel = i === rowIndex()
      const exp = expandedIds().has(e.sessionId)
      const arrow = sel ? (exp ? "▼" : "▶") : " "
      const title = truncate(e.summary || e.sessionId, 36)
      const self = e.sessionId === props.selfId ? " ★" : ""
      const dir = shortDir(e.directory)
      const age = formatAge(Date.now() - e.updatedAt)
      const del = confirmingDelete() === e.sessionId ? " ⚠ delete?" : ""
      lines.push({
        text: truncate(`${arrow} ${title}${self}  ${dir}  ${age}${del}`, LINE_WIDTH),
        style: sel ? "selected" : "normal",
      })
      if (exp) {
        const details: string[] = [
          truncate(`    ID:  ${e.sessionId}`, LINE_WIDTH),
          truncate(`    Sum: ${e.summary}`, LINE_WIDTH),
          truncate(`    Dir: ${e.directory}`, LINE_WIDTH),
          truncate(`    Prj: ${e.projectId}`, LINE_WIDTH),
          truncate(`    Dev: ${e.deviceName ?? "unknown"}`, LINE_WIDTH),
          truncate(`    Srv: ${e.serverUrl ?? ""}`, LINE_WIDTH),
          "",
        ]
        for (const d of details) lines.push({ text: d, style: "muted" })
      }
    }
    return lines
  }

  function visibleLines(): VLine[] {
    const all = buildLines()
    let selLine = 0
    let count = 0
    const tab = currentTab()
    if (tab) {
      for (let i = 0; i < tab.items.length; i++) {
        if (i === rowIndex()) {
          selLine = count
          break
        }
        count++
        if (expandedIds().has(tab.items[i].sessionId))
          count += EXPANDED_EXTRA
      }
    }
    const half = Math.floor(VIEWPORT_ROWS / 2)
    let top = selLine - half
    if (top < 0) top = 0
    if (top + VIEWPORT_ROWS > all.length) top = Math.max(0, all.length - VIEWPORT_ROWS)
    setScrollTop(top)
    return all.slice(top, top + VIEWPORT_ROWS)
  }

  function tabLine(): string {
    return devices()
      .map((dev, i) => {
        const active = i === tabIndex()
        const local = dev.name === localDevice
        const label = local ? `${dev.name} (local)` : dev.name
        return `${active ? "▸ " : "  "}${label} (${dev.items.length})`
      })
      .join("   ")
  }

  useKeyboard((evt) => {
    if (evt.name === "q" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      context.ui.dialog.clear()
      return
    }
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      switchTab(evt.shift ? -1 : 1)
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      moveRow(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      moveRow(1)
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      const entry = currentTab()?.items[rowIndex()]
      if (entry) toggleExpand(entry.sessionId, true)
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      const entry = currentTab()?.items[rowIndex()]
      if (entry) toggleExpand(entry.sessionId, false)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      setConfirmingDelete(null)
      const entry = currentTab()?.items[rowIndex()]
      if (!entry) return
      if (copyToClipboard(formatSessionInfo(entry))) {
        context.ui.toast.show({
          variant: "success",
          message: `Copied session info for ${entry.sessionId}`,
        })
      }
      return
    }
    if (evt.name === "backspace" || evt.name === "delete") {
      evt.preventDefault()
      evt.stopPropagation()
      const entry = currentTab()?.items[rowIndex()]
      if (!entry) return
      if (confirmingDelete() === entry.sessionId) {
        void (async () => {
          try {
            await deleteSession(entry.sessionId)
            const updated = entries().filter(
              (e) => e.sessionId !== entry.sessionId,
            )
            setEntries(updated)
            setConfirmingDelete(null)
            if (updated.length === 0) {
              context.ui.dialog.clear()
              context.ui.toast.show({ variant: "info", message: "No sessions." })
              return
            }
            const devNames = [
              ...new Set(updated.map((e) => e.deviceName ?? "unknown")),
            ]
            if (tabIndex() >= devNames.length)
              setTabIndex(devNames.length - 1)
            const tabItems = updated.filter(
              (e) =>
                (e.deviceName ?? "unknown") === devNames[tabIndex()],
            )
            setRowIndex((i) =>
              Math.min(i, Math.max(0, tabItems.length - 1)),
            )
            context.ui.toast.show({
              variant: "success",
              message: `Removed ${entry.sessionId}`,
            })
          } catch (error) {
            setConfirmingDelete(null)
            context.ui.toast.show({
              variant: "error",
              message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        })()
      } else {
        setConfirmingDelete(entry.sessionId)
      }
      return
    }
  })

  return (
    <box flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
      <text fg={theme.text.base}>
        {`Peer Sessions (${entries().length})  tab·↑↓·←→·⏎·⌫·esc`}
      </text>
      <text fg={theme.text.muted}>{tabLine()}</text>
      <text fg={theme.text.base}>{""}</text>
      <For each={visibleLines()}>
        {(line) => (
          <text
            fg={
              line.style === "selected"
                ? theme.text.action.primary.focused
                : line.style === "muted"
                  ? theme.text.muted
                  : theme.text.base
            }
          >
            {line.text || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function RelayStatusPanel(props: {
  port: number
  localIp: string
}) {
  const context = usePlugin()
  const theme = context.theme

  const [peers, setPeers] = createSignal(activeRelay?.peersByDevice ?? [])
  const timer = setInterval(() => {
    if (activeRelay) setPeers(activeRelay.peersByDevice)
  }, 1_000)
  onCleanup(() => clearInterval(timer))

  useKeyboard((evt) => {
    if (evt.name === "q" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      context.ui.dialog.clear()
      return
    }
    if (evt.name === "s") {
      evt.preventDefault()
      evt.stopPropagation()
      if (activeRelay) {
        activeRelay.stop()
        activeRelay = null
        stopRelayPolling()
        stopClientPolling()
        void clearRelayUrl()
        context.ui.dialog.clear()
        context.ui.toast.show({
          variant: "info",
          message: "Relay server stopped.",
        })
      }
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      evt.stopPropagation()
      const url = `http://${props.localIp}:${props.port}`
      if (copyToClipboard(url)) {
        context.ui.toast.show({ variant: "success", message: `Copied: ${url}` })
      }
      return
    }
  })

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      flexDirection="column"
    >
      <text fg={theme.text.base}>
        <b>Relay Server</b>
      </text>
      <box flexDirection="column" paddingLeft={2} gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.muted}>Listen:</text>
          <text fg={theme.text.action.primary.focused}>
            http://{props.localIp}:{props.port}
          </text>
        </box>
      </box>
      <Show when={peers().length > 0}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <For each={peers()}>
            {(pg) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.text.base}>{pg.device}</text>
                <text fg={theme.text.muted}>
                  ({pg.count} {pg.count === 1 ? "peer" : "peers"})
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <text fg={theme.text.muted}>c copy URL · s stop · esc close</text>
      <box paddingTop={1}>
        <text fg={theme.text.muted}>
          On other machines: /join http://{props.localIp}:{props.port}
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    startClientPolling()

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${PLUGIN_ID}.peers`,
          title: "Show active peer sessions",
          group: "Sessions",
          palette: true,
          slash: { name: "peers" },
          run: async () => {
            try {
              let entries: RegistryEntry[]
              const relayUrl = getRelayUrl()
              if (relayUrl) {
                const res = await fetch(`${relayUrl}/api/list`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    clientId: `tui-peers-${randomUUID().slice(0, 8)}`,
                    requestId: randomUUID(),
                  }),
                })
                const data = (await res.json()) as {
                  entries?: RegistryEntry[]
                }
                entries = data.entries ?? []
              } else {
                entries = await listEntries()
              }
              if (entries.length === 0) {
                context.ui.toast.show({
                  variant: "info",
                  message: "No sessions are currently registered.",
                })
                return
              }
              context.ui.dialog.set({ size: "large" })
              context.ui.dialog.show(() => (
                <PeersPanel entries={entries} />
              ))
            } catch (error) {
              context.ui.toast.show({
                variant: "error",
                message: `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          },
        },
        {
          id: `${PLUGIN_ID}.register`,
          title: "Register current session",
          group: "Sessions",
          palette: true,
          slash: { name: "register" },
          run: async () => {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({
                variant: "warning",
                message: "Navigate to a session first.",
              })
              return
            }
            const sessionID = route.sessionID
            const session = context.data.session.get(sessionID)
            if (!session) {
              context.ui.toast.show({
                variant: "warning",
                message: "Session not found in local cache.",
              })
              return
            }
            const defaultSummary = session.title ?? ""
            // V2 note: LocationRef carries no project metadata; the registry's
            // projectId comes from the session itself (V1 recorded the
            // worktree path here — see the port summary).
            const projectId = session.projectID
            const summary = await context.ui.dialog.prompt({
              title: "Register Session",
              placeholder: "e.g. refactoring OAuth in src/auth/oauth.ts",
              value: defaultSummary,
            })
            // undefined = dialog cancelled (Escape / replaced) — V1 onCancel
            // only cleared the dialog, so cancel stays silent here too.
            if (summary === undefined) return
            const trimmed = summary.trim()
            if (trimmed.length < 5) {
              context.ui.toast.show({
                variant: "warning",
                message: "Summary must be at least 5 characters.",
              })
              return
            }
            try {
              const loc =
                context.location ?? context.data.location.default()
              const relayUrl = getRelayUrl()
              if (relayUrl) {
                const res = await fetch(`${relayUrl}/api/register`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    clientId: `tui-reg-${randomUUID().slice(0, 8)}`,
                    sessionId: sessionID,
                    summary: trimmed,
                    directory: loc.directory,
                    projectId,
                    deviceName: hostname(),
                  }),
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
              }
              await upsertEntry({
                sessionId: sessionID,
                summary: trimmed,
                directory: loc.directory,
                projectId,
              })
              context.ui.toast.show({
                variant: "success",
                message: `Session registered: ${trimmed}`,
              })
            } catch (error) {
              context.ui.toast.show({
                variant: "error",
                message: `Failed to register: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          },
        },
        {
          id: `${PLUGIN_ID}.relay`,
          title: "Start/stop relay server",
          group: "Sessions",
          palette: true,
          slash: { name: "relay" },
          run: async () => {
            if (activeRelay) {
              const localIp = getLocalIp()
              context.ui.dialog.set({ size: "medium" })
              context.ui.dialog.show(() => (
                <RelayStatusPanel
                  port={activeRelay!.port}
                  localIp={localIp}
                />
              ))
              return
            }

            const portStr = await context.ui.dialog.prompt({
              title: "Start Relay Server",
              placeholder: `Port (default: ${RELAY_DEFAULT_PORT})`,
              value: String(RELAY_DEFAULT_PORT),
            })
            if (portStr === undefined) return
            const port = parseInt(portStr.trim(), 10) || RELAY_DEFAULT_PORT
            if (port < 1024 || port > 65535) {
              context.ui.toast.show({
                variant: "error",
                message: "Port must be between 1024 and 65535.",
              })
              return
            }
            try {
              const { RelayServer } = await import("./src/relay/server.ts")
              activeRelay = new RelayServer(port)
              activeRelay.start()
              startRelayPolling()
              const localIp = getLocalIp()
              const selfUrl = `http://127.0.0.1:${port}`
              await writeRelayUrl(selfUrl)
              startClientPolling()
              context.ui.toast.show({
                variant: "success",
                message: `Relay started on http://${localIp}:${port}`,
              })
            } catch (error) {
              activeRelay = null
              context.ui.toast.show({
                variant: "error",
                message: `Failed to start relay: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          },
        },
        {
          id: `${PLUGIN_ID}.join`,
          title: "Join a relay server",
          group: "Sessions",
          palette: true,
          slash: { name: "join" },
          run: async () => {
            const history = getRelayHistory()

            const doJoin = async (url: string) => {
              const trimmed = url.trim()
              if (
                !trimmed.startsWith("http://") &&
                !trimmed.startsWith("https://")
              ) {
                context.ui.toast.show({
                  variant: "error",
                  message: "URL must start with http:// or https://",
                })
                return
              }
              try {
                await writeRelayUrl(trimmed)
                context.ui.toast.show({
                  variant: "success",
                  message: `Connecting to ${trimmed}...`,
                })
              } catch (error) {
                context.ui.toast.show({
                  variant: "error",
                  message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                })
              }
            }

            if (history.length > 0) {
              const selected = await context.ui.dialog.select<string>({
                title: "Join Relay",
                options: [
                  ...history.map((url) => ({
                    title: url,
                    value: url,
                    description: "Reconnect",
                  })),
                  {
                    title: "Enter new URL...",
                    value: "__new__",
                    description: "Join a different relay",
                  },
                ],
              })
              if (selected === undefined) return
              if (selected === "__new__") {
                const url = await context.ui.dialog.prompt({
                  title: "Join Relay",
                  placeholder: "http://192.168.1.100:7351",
                })
                if (url !== undefined) await doJoin(url)
              } else {
                await doJoin(selected)
              }
            } else {
              const url = await context.ui.dialog.prompt({
                title: "Join Relay",
                placeholder: "ws://192.168.1.100:7351",
              })
              if (url !== undefined) await doJoin(url)
            }
          },
        },
      ],
    }))

    // V1 slot `sidebar_title` has no V2 equivalent; `sidebar.content` is the
    // nearest published slot (host slot tree per @opencode/plugin 2.0.30).
    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const server = relayInfo()
        const client = clientInfo()
        if (!server && !client) return <></>
        const theme = context.theme
        const peers = server?.peers ?? client?.peers ?? []
        const totalPeers = peers.reduce((s, p) => s + p.count, 0)
        return (
          <box flexDirection="column" paddingLeft={1} paddingBottom={1}>
            <Show when={server}>
              <text fg={theme.text.feedback.success.base}>
                <b>⚡ SERVER :{server!.port}</b>
              </text>
              <text fg={theme.text.muted}>
                http://{server!.localIp}:{server!.port}
              </text>
            </Show>
            <Show when={!server && client}>
              <text fg={theme.text.action.primary.focused}>
                <b>⚡ CLIENT</b>
              </text>
              <text fg={theme.text.muted}>{client!.url}</text>
            </Show>
            <Show
              when={peers.length > 0}
              fallback={
                <text fg={theme.text.muted}>
                  {server ? "waiting for peers..." : "no peers"}
                </text>
              }
            >
              <text fg={theme.text.base}>
                {totalPeers} {totalPeers === 1 ? "peer" : "peers"}
              </text>
              <box flexDirection="column" paddingLeft={2}>
                <For each={peers}>
                  {(pg) => (
                    <text fg={theme.text.muted}>
                      {pg.device} ({pg.count})
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        )
      },
    })

    // V1 `api.lifecycle.onDispose` → V2 cleanup function returned from setup.
    return () => {
      stopClientPolling()
      stopRelayPolling()
    }
  },
})
