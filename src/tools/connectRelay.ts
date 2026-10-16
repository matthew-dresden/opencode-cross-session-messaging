import { tool } from "@opencode-ai/plugin/tool"
import { log } from "../logger.ts"
import { writeRelayUrl } from "../config.ts"
import type { DelegatingTransport } from "../transport/delegating.ts"
import type { ToolOutcome } from "./registerSession.ts"

export interface ConnectRelayDeps {
  transport: DelegatingTransport
  /** Mutator so the caller's config-poller keeps tracking the latest URL. */
  setLastKnownUrl: (url: string) => void
}

/**
 * Shared relay-connect logic for the V1 tool map and the V2 transform.
 * Relay-essential: connection failures are loud (returned to the calling
 * model), never swallowed.
 */
export async function connectRelayCore(
  deps: ConnectRelayDeps,
  rawUrl: string,
): Promise<ToolOutcome> {
  const url = rawUrl.trim()
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return {
      title: "invalid URL",
      output: "connect_relay error: URL must start with http:// or https://",
    }
  }
  try {
    const { RelayTransport } = await import("../transport/relay.ts")
    await deps.transport.switchTo(new RelayTransport(url))
    await writeRelayUrl(url)
    deps.setLastKnownUrl(url)
    log.info("connect_relay:ok", { url })
    return {
      title: "connected",
      output: `Connected to relay: ${url}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("connect_relay:fail", { url, error: msg })
    return {
      title: "connect failed",
      output: `connect_relay error: ${msg}`,
    }
  }
}

export function createConnectRelayTool(
  deps: ConnectRelayDeps,
): ReturnType<typeof tool> {
  return tool({
    description:
      "Connect this daemon to a remote relay server for cross-device session messaging. " +
      "Takes effect immediately (no restart needed) and persists across restarts.",
    args: {
      url: tool.schema
        .string()
        .min(5)
        .describe(
          "HTTP URL of the relay server (e.g. http://192.168.1.100:7351).",
        ),
    },
    async execute(args) {
      return connectRelayCore(deps, args.url)
    },
  })
}
