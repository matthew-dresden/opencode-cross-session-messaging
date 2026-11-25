# cross-session-messaging

**[中文文档](./README.zh-CN.md)**

An [OpenCode](https://opencode.ai) **plugin** that lets multiple sessions on the same machine communicate with each other — regardless of whether they share the same daemon process. Any session can register its task summary to a shared registry, discover other active sessions, and send a **blocking question** to a target session, which automatically generates an AI reply.

> **Status**: Core implemented: 4 tools + `session.deleted` event hook + TUI panel + **155 unit tests, 0 failures** + clean `tsc --noEmit`.

## Why

In multi-agent orchestration scenarios, sessions need to exchange context across conversations, but OpenCode has no built-in "A asks B" primitive. This plugin fills that gap.

**Why an in-process plugin instead of an external MCP server?** External MCP servers have HTTP timeouts that interrupt long waits. An in-process plugin's `execute()` has no such limitation — it can block for minutes waiting for a reply without the transport layer disconnecting.

**Why file-based IPC?** Sessions may run in different daemon processes (e.g., different terminal windows). The file-based transport layer (`~/.local/state/opencode/messages/`) enables cross-daemon communication without a shared service process. Each daemon runs an `InboxWatcher` that polls for inbound requests belonging to its sessions.

## Four Tools

| Tool | Purpose |
|---|---|
| `register_session(summary)` | Register the current session's task summary to the shared registry |
| `list_sessions(includeSelf?)` | Read the registry to pick targets for `ask_session` (excludes self by default; entries older than 24h are auto-hidden) |
| `ask_session(sessionId, question, timeoutMs?)` | Send a question to the target session and wait for an AI reply. **Never throws** — all failure paths return readable error text |
| `connect_relay(url, token?)` | Connect this daemon to a relay server. Security gate: https required (http only for loopback/localhost), host must be on the operator-managed `allowedRelayHosts` allowlist, token from the argument, `CROSS_SESSION_RELAY_TOKEN`, `RELAY_TOKEN`, or the stored config token. Refusals return remediation text and persist nothing |

`ask_session` defaults to a 60-second timeout with a 10-minute maximum. Regardless of the failure type (target not found, timeout, abort, empty reply), it returns descriptive error text and never throws exceptions.

## Workflow

```
Session A (Daemon 1)                    Session B (Daemon 2)
────────────────────                    ────────────────────
1. ask_session(B, question)
   │
   ├─ Validate B exists in registry
   ├─ Write .req.json to messages/
   ├─ Poll for .res.json ...            InboxWatcher scans messages/
   │                                     ├─ Discovers B's .req.json
   │                                     ├─ Validates daemonId ownership
   │                                     ├─ Sends prompt via SDK
   │                                     ├─ Polls for assistant reply
   │                                     └─ Writes .res.json
   ├─ Reads .res.json
   ├─ Cleans up both files
   └─ Returns reply text
```

### Request/Response Lifecycle

1. **Caller** writes `{requestId}.req.json` containing the question
2. **Target's InboxWatcher** picks up the file, validates `daemonId` ownership, sends the prompt via `client.session.promptAsync`, and polls for the assistant reply
3. **Target's InboxWatcher** writes `{requestId}.res.json` containing the reply (or error)
4. **Caller** reads the response and cleans up both files

All registry, request/response, relay-config, and token file writes use **temp file + rename atomic swap**, so readers never see partially written files. (The suppression file is a single small plain write.)

## Storage Locations

| Path | Purpose |
|---|---|
| `~/.local/state/opencode/agents-registry.json` | Shared session registry (or `$XDG_STATE_HOME/opencode/`) |
| `~/.local/state/opencode/messages/` | File-based IPC directory for cross-daemon request/response files |

Both paths are **user-level** (not project-level), so sessions across different git repos can discover each other.

### Concurrency Safety

- **In-process**: An async promise chain (`writeChain`) serializes all read-modify-write operations on the registry within the same daemon process
- **Cross-process**: POSIX temp+rename atomicity ensures readers never see partially written files. Concurrent cross-process writes use last-writer-wins
- **Staleness fallback**: Each registry entry has a 24h TTL on `updatedAt`, serving as a safety net in case `session.deleted` events are missed

## Security Model (v1.0.1)

The relay path (the only surface that leaves the machine) enforces the
controls below. Local file IPC stays on the user's own state directory; its
registry, request/response, relay-config, and token files are owner-only
(0600). The exception is the suppression file
(`cross-session-suppressed.json`), which is plain 0644 pre-existing code.

- **Shared-token auth**: the relay server requires the shared token on every
  data surface (`/api/*`, `/stats`, `/ws`). Clients send
  `Authorization: Bearer <token>`, or `?token=<token>` where headers are not
  available (dashboard WebSocket). The token value is never logged.
  Resolution is per side:
  - server: `--token`, then `RELAY_TOKEN`, then the 0600 token file
    `cross-session-relay-token` in the state directory, then generate and
    persist one to that file.
  - client: the `connect_relay` token argument, then
    `CROSS_SESSION_RELAY_TOKEN`, then `RELAY_TOKEN`, then the token stored
    in `cross-session-relay.json` by a previous connect. The client never
    generates a token.
  Generated tokens are 256-bit; operator-supplied tokens should be
  comparable in strength, and the env or token-file channels are preferred
  over `--token`, which is visible in the local process list.
- **Loopback-default bind**: the relay binds `127.0.0.1` unless the operator
  passes an explicit `--host`; binding a wider interface is a deliberate
  operator decision.
- **Host allowlist**: `connect_relay` honors only relay URLs whose host is
  listed in `allowedRelayHosts` in the relay config file
  (`cross-session-relay.json`). An empty allowlist refuses every connect.
  Refusals name the offending host and the config path so the operator can
  remediate. The allowlist is not writable through any tool: the calling
  model can never widen its own relay permissions.
- **https enforcement**: plaintext `http` is accepted only for
  loopback/localhost relays (local dev exception); every other relay URL
  must use `https`. Plugin init and the config poller apply the same policy
  to stored relay URLs and re-evaluate on every policy-input change (relay
  URL, allowlist, token): a refusal is logged (rate-limited) and the daemon
  stays on file IPC; a live relay that stops matching the policy is torn
  down and the daemon falls back to file IPC.
- **Preview privacy default OFF**: relay broadcast events and the dashboard
  snapshot carry session ids, task summaries, directories, projectId,
  deviceName, client IPs, and timing. Only question TEXT is preview-gated
  (default off, opt-in via `--previews`). Question delivery to the target
  session is unaffected.
- **0600 file writes**: the session registry, the request/response IPC
  files, the relay config file (which carries the token), and the generated
  token file are written owner-only (0600) from creation, via temp file +
  rename with mode 0600 at creation (a re-chmod is kept as belt-and-braces).

## TUI Plugin

The package also exports a TUI plugin (`tui.tsx`) that adds two slash commands to OpenCode TUI:

| Command | Function |
|---|---|
| `/peers` | Opens a navigable dialog listing all registered sessions. Press Enter to copy session info (including `ask_session` template) to clipboard |
| `/register` | Opens an input prompt to register a task summary for the current session |

## Installation

The package ships both plugin shapes from one entrypoint: opencode v2 hosts
call `setup()` and v1 hosts (>= 1.18.29) call `server()`.

### Plugin (tools + inbox watcher)

Add to `~/.config/opencode/opencode.json` (v2 config uses the `plugins` key):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@matthew-dresden/opencode-cross-session-messaging"]
}
```

### TUI (optional — `/peers`, `/register`, `/relay`, `/join` commands)

The TUI plugin targets the opencode **v2** CLI plugin API. Add it to
`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["@matthew-dresden/opencode-cross-session-messaging/tui"]
}
```

The v1 `tui.json` plugin entry is no longer supported: `tui.tsx` imports
`@opencode/plugin/tui`, which the v2 CLI host resolves at runtime.

After changing the config, **fully quit and reopen** OpenCode.

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 155 tests / 20 files
```

## Directory Structure

```
src/
├── index.ts                 # Entry — dual-shape default export (V1 server() + V2 setup())
├── v2types.ts               # Minimal structural types for the V2 plugin context
├── v2Tools.ts               # V2 tool definitions (ctx.tool.transform / JSON Schema)
├── v2ClientAdapter.ts       # V2 ctx.session domain → ask-pipeline client seam
├── constants.ts             # PLUGIN_ID, timeouts, backoff, TTL, file layout constants
├── types.ts                 # RegistryEntry / Registry / param interfaces / Error subclasses
├── xdg.ts                   # XDG_STATE_HOME resolution + getRegistryPath()
├── logger.ts                # Logger helper with PLUGIN_ID tag
├── registry.ts              # Atomic file I/O + in-process mutex chain
├── fileTransport.ts         # File-based IPC: request/response file write, read, poll
├── inbox.ts                 # InboxWatcher — polls messages/ directory, processes inbound requests
├── askAndWaitForReply.ts    # Send prompt + poll for assistant reply
├── eventHooks.ts            # session.deleted handling: V1 hook factory + V2 subscription loop
├── abort.ts                 # AbortSignal utilities (abortableSleep, withAbortCleanup)
└── tools/
    ├── registerSession.ts   # Tool: register_session (core shared by V1/V2 shapes)
    ├── listSessions.ts      # Tool: list_sessions (core shared by V1/V2 shapes)
    ├── askSession.ts        # Tool: ask_session (core shared by V1/V2 shapes)
    └── connectRelay.ts      # Tool: connect_relay (core shared by V1/V2 shapes)
tui.tsx                      # V2 CLI plugin — /peers, /register, /relay, /join (SolidJS)
SKILL.md                     # LLM usage guide (skill definition)
test/manual/
└── MANUAL_TEST_PLAN.md      # 5-scenario E2E manual test plan
```

### Module Dependency Graph

```
index.ts
├── tools/registerSession.ts → registry.ts → xdg.ts, types.ts
├── tools/listSessions.ts   → registry.ts
├── tools/askSession.ts      → fileTransport.ts → abort.ts, xdg.ts
│                            → registry.ts (validation)
├── inbox.ts                 → fileTransport.ts, askAndWaitForReply.ts, registry.ts
├── eventHooks.ts            → registry.ts
├── logger.ts                → constants.ts
└── constants.ts (leaf node)
```

## Known Limitations

- **No deadlock detection** — If A waits for B and B asks A back, both sides will time out independently rather than reporting immediately. The MVP uses timeouts as a fallback without active cycle detection.
- **Single-user trust boundary**: the relay requires the shared token and the operator's host allowlist (see Security Model), but any process of the same user holding the token can send messages. Multi-user/multi-tenant scenarios require redesign.
- **No message queue** — Each `ask_session` call is an atomic request from start to finish, with no queuing or retry.
- **No cross-session history** — Each `ask_session` is a fresh task for the target — the target session **cannot see** the caller's conversation history. Therefore the `question` parameter **must be self-contained** (include all background, code snippets, and constraints).
- **Polling-based** — Both the inbox watcher and response polling use timers (1s and 500ms respectively) rather than filesystem events. Sufficient for the expected traffic volume.

## Related Documentation

- [`SKILL.md`](./SKILL.md) — LLM usage guide specifying when to call each tool, how to write self-contained questions, and common pitfalls
- [`test/manual/MANUAL_TEST_PLAN.md`](./test/manual/MANUAL_TEST_PLAN.md) — 5 end-to-end scenario scripts for real OpenCode environments

## License

MIT
