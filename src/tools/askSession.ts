import { tool } from "@opencode-ai/plugin/tool"
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
} from "../constants.ts"
import { log } from "../logger.ts"
import type { ITransport } from "../transport/interface.ts"
import { AskTimeoutError } from "../types.ts"
import { randomUUID } from "node:crypto"

/**
 * Ask outcome: either the target's reply text (V1 returns the bare string to
 * preserve its exact wire behavior) or a `{ title, output }` error outcome.
 */
export type AskSessionOutcome = { reply: string } | ToolOutcomeError

export interface ToolOutcomeError {
  title: string
  output: string
}

export interface AskSessionCall {
  selfSessionId: string
  sessionId: string
  question: string
  timeoutMs?: number
  abort?: AbortSignal
}

/**
 * Shared ask logic for the V1 tool map and the V2 transform. NEVER throws —
 * every failure mode is converted to a user-facing error outcome. This is the
 * relay-essential path: registry-read and ask failures are loud (returned to
 * the calling model), while non-essential logging stays in `log.warn`.
 */
export async function askSessionCore(
  transport: ITransport,
  call: AskSessionCall,
): Promise<AskSessionOutcome> {
  if (call.sessionId === call.selfSessionId) {
    return {
      title: "self-ask forbidden",
      output:
        `ask_session error: cannot ask yourself (sessionId ${call.sessionId} is this session). ` +
        `Use list_sessions to find a different target.`,
    }
  }

  const budget = Math.min(
    call.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
    MAX_ASK_TIMEOUT_MS,
  )

  try {
    const entry = await transport.lookup(call.sessionId)
    if (!entry) {
      return {
        title: "not in registry",
        output:
          `ask_session error: session ${call.sessionId} is not in the registry. ` +
          `It may have exited or never registered. Call list_sessions to see current active sessions.`,
      }
    }
    if (!entry.daemonId) {
      return {
        title: "target has no daemonId",
        output:
          `ask_session error: session ${call.sessionId} was registered by an older plugin version ` +
          `that did not record its daemon identity. Ask the target session to call register_session again.`,
      }
    }
  } catch (err: unknown) {
    log.warn("ask_session:registry-read-fail", { error: String(err) })
    return {
      title: "registry read error",
      output:
        `ask_session error: could not read the shared registry: ${
          err instanceof Error ? err.message : String(err)
        }. The registry file may be corrupt.`,
    }
  }

  const requestId = randomUUID()
  try {
    const res = await transport.ask({
      requestId,
      toSessionId: call.sessionId,
      question: call.question,
      timeoutMs: budget,
      abort: call.abort,
    })
    if (res.error) {
      return {
        title: "target error",
        output: `ask_session error: target session reported an error: ${res.error}`,
      }
    }
    if (!res.reply) {
      return {
        title: "empty reply",
        output: `ask_session error: session ${call.sessionId} produced an empty reply.`,
      }
    }
    log.info("ask_session:ok", {
      sessionId: call.sessionId,
      replyChars: res.reply.length,
    })
    return { reply: res.reply }
  } catch (err: unknown) {
    if (err instanceof AskTimeoutError) {
      return {
        title: "reply timeout",
        output:
          `ask_session error: session ${call.sessionId} did not respond within ${budget}ms. ` +
          `The target may be busy or its inbox watcher may not be running. ` +
          `Try again with a larger timeoutMs (max ${MAX_ASK_TIMEOUT_MS}).`,
      }
    }
    const errName =
      err && typeof err === "object" && "name" in err
        ? String((err as { name?: unknown }).name)
        : ""
    if (errName === "AbortError") {
      return {
        title: "aborted",
        output: `ask_session error: the ask was aborted (either by tool cancellation or user interrupt).`,
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    log.warn("ask_session:unknown-error", {
      sessionId: call.sessionId,
      error: errMsg,
    })
    return {
      title: "unexpected error",
      output: `ask_session error: unexpected error contacting session ${call.sessionId}: ${errMsg}`,
    }
  }
}

export function createAskSessionTool(
  transport: ITransport,
): ReturnType<typeof tool> {
  return tool({
    description: [
      "Send a self-contained question to ANOTHER opencode session and wait for its AI-generated reply.",
      "The target session CANNOT see your conversation history — include ALL necessary context",
      "(background, code snippets, constraints) in the `question` text itself.",
      "If the target is busy, this tool waits (bounded) for it to become idle.",
      "On any failure, returns a clear error string. This tool NEVER throws.",
    ].join(" "),
    args: {
      sessionId: tool.schema
        .string()
        .min(1)
        .describe("Target session ID (obtain from `list_sessions`)."),
      question: tool.schema
        .string()
        .min(5)
        .max(20_000)
        .describe(
          "The full self-contained question. Include background, code snippets, constraints — " +
            "the target session sees ONLY this text, nothing from your own conversation history.",
        ),
      timeoutMs: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Total reply-wait budget in ms. Default ${DEFAULT_ASK_TIMEOUT_MS}, hard-clamped to ${MAX_ASK_TIMEOUT_MS}.`,
        ),
    },
    async execute(args, ctx) {
      const outcome = await askSessionCore(transport, {
        selfSessionId: ctx.sessionID,
        sessionId: args.sessionId,
        question: args.question,
        timeoutMs: args.timeoutMs,
        abort: ctx.abort,
      })
      return "reply" in outcome ? outcome.reply : outcome
    },
  })
}
