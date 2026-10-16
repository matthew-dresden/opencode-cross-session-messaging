import { tool } from "@opencode-ai/plugin/tool"
import { log } from "../logger.ts"
import type { ITransport } from "../transport/interface.ts"

/** What a tool execution reports back to its host (V1 wire shape). */
export interface ToolOutcome {
  title: string
  output: string
}

export interface RegisterSessionDeps {
  transport: ITransport
  projectId: string
  /** Informational registry field; unset for V2 registrations (no V2 equivalent). */
  serverUrl?: string
  daemonId: string
  deviceName: string
}

export interface RegisterSessionCall {
  sessionId: string
  directory: string
  summary: string
}

/**
 * Shared registration logic for the V1 tool map and the V2 transform.
 * Returns the V1 `{ title, output }` outcome; the V2 shape wraps `output`
 * as `{ content }` (the V1 `title` is TUI sugar with no V2 payload field).
 */
export async function registerSessionCore(
  deps: RegisterSessionDeps,
  call: RegisterSessionCall,
): Promise<ToolOutcome> {
  const summary = call.summary.trim()
  if (summary.length < 5) {
    return {
      title: "register failed",
      output: `register_session error: summary must be at least 5 non-whitespace chars (got ${summary.length}).`,
    }
  }
  try {
    const entry = await deps.transport.register({
      sessionId: call.sessionId,
      summary,
      directory: call.directory,
      projectId: deps.projectId,
      serverUrl: deps.serverUrl,
      daemonId: deps.daemonId,
      deviceName: deps.deviceName,
    })
    log.info("register_session:ok", {
      sessionId: call.sessionId,
      summaryChars: summary.length,
    })
    return {
      title: "registered",
      output:
        `Registered session ${call.sessionId}.\n` +
        `Summary: ${summary}\n` +
        `Directory: ${call.directory}\n` +
        `Project: ${deps.projectId}\n` +
        `Updated: ${new Date(entry.updatedAt).toISOString()}`,
    }
  } catch (error) {
    log.warn("register_session:fail", { error: String(error) })
    return {
      title: "register failed",
      output: `register_session failed: ${String(error)}`,
    }
  }
}

export function createRegisterSessionTool(
  transport: ITransport,
  input: {
    projectId: string
    serverUrl: string
    daemonId: string
    deviceName: string
  },
): ReturnType<typeof tool> {
  return tool({
    description: [
      "Advertise THIS session's current task in the shared cross-session registry",
      "so other sessions can find you by natural-language summary and, via `ask_session`,",
      "send you a question. Call once when your task is well-defined; call again to update.",
    ].join(" "),
    args: {
      summary: tool.schema
        .string()
        .min(5)
        .max(2000)
        .describe(
          "Natural-language summary of what THIS session is currently working on. " +
            "Be specific (e.g. 'refactoring token refresh in src/auth/oauth.ts' beats 'writing code'). " +
            "Other sessions read this to decide whether to ask you.",
        ),
    },
    async execute(args, ctx) {
      return registerSessionCore(
        { transport, ...input },
        {
          sessionId: ctx.sessionID,
          directory: ctx.directory,
          summary: args.summary,
        },
      )
    },
  })
}
