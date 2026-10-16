import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
} from "./constants.ts"
import type { ITransport } from "./transport/interface.ts"
import type { DelegatingTransport } from "./transport/delegating.ts"
import { askSessionCore } from "./tools/askSession.ts"
import { connectRelayCore } from "./tools/connectRelay.ts"
import { listSessionsCore } from "./tools/listSessions.ts"
import {
  registerSessionCore,
  type ToolOutcome,
} from "./tools/registerSession.ts"
import type {
  V2ToolContext,
  V2ToolDefinition,
  V2ToolResult,
} from "./v2types.ts"

/**
 * V2 tool definitions (`ctx.tool.transform` → `editor.add`), one per V1 tool
 * map entry. Inputs are JSON Schema translations of the V1 `tool.schema`
 * builders (identical constraints and description strings); execution returns
 * structured `{ content }` instead of the V1 `{ title, output }` map value.
 *
 * The V1 `title` has no V2 payload field and is dropped; `output` text is
 * carried verbatim in `content`.
 */

function toContent(outcome: ToolOutcome): V2ToolResult {
  return { content: outcome.output }
}

export interface V2ToolDeps {
  transport: ITransport
  delegating: DelegatingTransport
  projectId: string
  /**
   * Informational registry field. V1 recorded the daemon's `input.serverUrl`;
   * the V2 context exposes no server URL, so V2 registrations leave it unset.
   */
  serverUrl?: string
  daemonId: string
  deviceName: string
  /**
   * The V2 `Tool.Context` carries no `directory`; the registry entry's
   * directory is the plugin instance's location, captured at setup (V1 read
   * it per-call from the tool context, which in V1 equals the daemon's
   * directory — see the port summary for this documented deviation).
   */
  directory: string
  setLastKnownUrl: (url: string) => void
}

export function buildV2Tools(deps: V2ToolDeps): V2ToolDefinition[] {
  const register: V2ToolDefinition = {
    name: "register_session",
    description:
      "Advertise THIS session's current task in the shared cross-session registry " +
      "so other sessions can find you by natural-language summary and, via `ask_session`, " +
      "send you a question. Call once when your task is well-defined; call again to update.",
    input: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 5,
          maxLength: 2000,
          description:
            "Natural-language summary of what THIS session is currently working on. " +
            "Be specific (e.g. 'refactoring token refresh in src/auth/oauth.ts' beats 'writing code'). " +
            "Other sessions read this to decide whether to ask you.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async execute(input, context: V2ToolContext) {
      const outcome = await registerSessionCore(deps, {
        sessionId: context.sessionID,
        directory: deps.directory,
        summary: String(input.summary ?? ""),
      })
      return toContent(outcome)
    },
  }

  const listSessions: V2ToolDefinition = {
    name: "list_sessions",
    description:
      "List active peer sessions in the registry, most recent first. " +
      "Excludes YOUR own session by default (pass includeSelf=true to include). " +
      "Stale entries (>24h since last update) are filtered automatically. " +
      "Use before `ask_session` to discover a target by summary.",
    input: {
      type: "object",
      properties: {
        includeSelf: {
          type: "boolean",
          description:
            "If true, include this session's own entry. Default false.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const outcome = await listSessionsCore(deps.transport, deps.deviceName, {
        selfSessionId: context.sessionID,
        includeSelf:
          typeof input.includeSelf === "boolean"
            ? input.includeSelf
            : undefined,
      })
      return toContent(outcome)
    },
  }

  const askSession: V2ToolDefinition = {
    name: "ask_session",
    description:
      "Send a self-contained question to ANOTHER opencode session and wait for its AI-generated reply. " +
      "The target session CANNOT see your conversation history — include ALL necessary context " +
      "(background, code snippets, constraints) in the `question` text itself. " +
      "If the target is busy, this tool waits (bounded) for it to become idle. " +
      "On any failure, returns a clear error string. This tool NEVER throws.",
    input: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description: "Target session ID (obtain from `list_sessions`).",
        },
        question: {
          type: "string",
          minLength: 5,
          maxLength: 20_000,
          description:
            "The full self-contained question. Include background, code snippets, constraints — " +
            "the target session sees ONLY this text, nothing from your own conversation history.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: `Total reply-wait budget in ms. Default ${DEFAULT_ASK_TIMEOUT_MS}, hard-clamped to ${MAX_ASK_TIMEOUT_MS}.`,
        },
      },
      required: ["sessionId", "question"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const outcome = await askSessionCore(deps.transport, {
        selfSessionId: context.sessionID,
        sessionId: String(input.sessionId ?? ""),
        question: String(input.question ?? ""),
        timeoutMs:
          typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        abort: context.signal,
      })
      return "reply" in outcome
        ? { content: outcome.reply }
        : toContent(outcome)
    },
  }

  const connectRelay: V2ToolDefinition = {
    name: "connect_relay",
    description:
      "Connect this daemon to a remote relay server for cross-device session messaging. " +
      "Takes effect immediately (no restart needed) and persists across restarts.",
    input: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 5,
          description:
            "HTTP URL of the relay server (e.g. http://192.168.1.100:7351).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input) {
      const outcome = await connectRelayCore(
        { transport: deps.delegating, setLastKnownUrl: deps.setLastKnownUrl },
        String(input.url ?? ""),
      )
      return toContent(outcome)
    },
  }

  return [register, listSessions, askSession, connectRelay]
}
