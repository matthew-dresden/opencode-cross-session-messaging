import { tool } from "@opencode-ai/plugin/tool"
import { log } from "../logger.ts"
import type { RegistryEntry } from "../types.ts"
import type { ITransport } from "../transport/interface.ts"
import type { ToolOutcome } from "./registerSession.ts"

export interface ListSessionsCall {
  selfSessionId: string
  includeSelf?: boolean
}

/**
 * Shared listing logic for the V1 tool map and the V2 transform.
 * Returns the V1 `{ title, output }` outcome; the V2 shape wraps `output`
 * as `{ content }`.
 */
export async function listSessionsCore(
  transport: ITransport,
  localDeviceName: string,
  call: ListSessionsCall,
): Promise<ToolOutcome> {
  try {
    const entries = await transport.list()
    const filtered = call.includeSelf
      ? entries
      : entries.filter((e) => e.sessionId !== call.selfSessionId)
    if (filtered.length === 0) {
      return { title: "0 sessions", output: "No sessions registered." }
    }

    const local: RegistryEntry[] = []
    const remoteByDevice = new Map<string, RegistryEntry[]>()

    for (const e of filtered) {
      const device = e.deviceName ?? "unknown"
      if (!e.deviceName || device === localDeviceName) {
        local.push(e)
      } else {
        let group = remoteByDevice.get(device)
        if (!group) {
          group = []
          remoteByDevice.set(device, group)
        }
        group.push(e)
      }
    }

    const now = Date.now()
    const sections: string[] = []
    let idx = 1

    if (local.length > 0) {
      sections.push(`## Local (${localDeviceName})`)
      for (const e of local) {
        sections.push(formatEntry(e, idx++, now))
      }
    }

    for (const [device, group] of remoteByDevice) {
      sections.push(`\n## Remote — ${device}`)
      for (const e of group) {
        sections.push(formatEntry(e, idx++, now))
      }
    }

    return {
      title: `${filtered.length} session(s)`,
      output: `Active sessions (${filtered.length}):\n\n${sections.join("\n\n")}`,
    }
  } catch (error) {
    log.warn("list_sessions:fail", { error: String(error) })
    return {
      title: "list failed",
      output: `list_sessions failed: ${String(error)}`,
    }
  }
}

export function createListSessionsTool(
  transport: ITransport,
  localDeviceName: string,
): ReturnType<typeof tool> {
  return tool({
    description: [
      "List active peer sessions in the registry, most recent first.",
      "Excludes YOUR own session by default (pass includeSelf=true to include).",
      "Stale entries (>24h since last update) are filtered automatically.",
      "Use before `ask_session` to discover a target by summary.",
    ].join(" "),
    args: {
      includeSelf: tool.schema
        .boolean()
        .optional()
        .describe("If true, include this session's own entry. Default false."),
    },
    async execute(args, ctx) {
      return listSessionsCore(transport, localDeviceName, {
        selfSessionId: ctx.sessionID,
        includeSelf: args.includeSelf,
      })
    },
  })
}

function formatEntry(e: RegistryEntry, idx: number, now: number): string {
  const age = formatAge(now - e.updatedAt)
  return (
    `${idx}. **${e.sessionId}** [project ${e.projectId}]\n` +
    `   Directory: ${e.directory}\n` +
    `   Summary: ${e.summary}\n` +
    `   Updated: ${age} ago`
  )
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
