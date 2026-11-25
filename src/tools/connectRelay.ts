import { tool } from "@opencode-ai/plugin/tool"
import {
  getAllowedRelayHosts,
  getRelayConfigPath,
  getRelayToken,
  writeRelayUrl,
} from "../config.ts"
import { log } from "../logger.ts"
import type { RelayUrlDecision } from "../relayPolicy.ts"
import { validateRelayUrl } from "../relayPolicy.ts"
import { isWeakRelayToken, MIN_RECOMMENDED_TOKEN_CHARS } from "../relay/token.ts"
import type { DelegatingTransport } from "../transport/delegating.ts"
import type { ToolOutcome } from "./registerSession.ts"

export interface ConnectRelayDeps {
  transport: DelegatingTransport
  /**
   * Notification hook kept as the tool-to-wiring contract (W1-U2d): the
   * wiring bumps its re-evaluation generation so the next poll tick
   * re-checks policy even when the config digest returned to a
   * previously-seen value.
   */
  setLastKnownUrl: (url: string) => void
}

/** Operator-facing remediation appended to every refusal. */
function remediationFor(decision: RelayUrlDecision, url: string): string {
  const configPath = getRelayConfigPath()
  switch (decision.code) {
    case "empty-allowlist":
      return `Remediation: the operator adds the relay host to "allowedRelayHosts" in ${configPath} (a JSON array of "hostname" or "hostname:port" entries), then this call can be retried.`
    case "not-allowed": {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        /* message already carries the raw input */
      }
      return `Remediation: the operator adds "${host}" to "allowedRelayHosts" in ${configPath}, then this call can be retried.`
    }
    case "scheme":
      return "Remediation: use an https relay URL; plaintext http is accepted only for loopback/localhost relays."
    default:
      return "Remediation: pass the full http(s) URL of a relay server."
  }
}

/**
 * Shared relay-connect logic for the V1 tool map and the V2 transform.
 * Relay-essential: connection failures are loud (returned to the calling
 * model), never swallowed.
 *
 * Security gate (remediation 2026-11): every URL must pass the relay policy
 * (https by default, loopback-only http exception, operator host allowlist)
 * before it is honored or persisted. Refusals carry a typed remediation
 * message; nothing is persisted on refusal. The allowlist itself is NOT
 * writable through any tool: the calling model must never be able to widen
 * its own relay permissions.
 */
export async function connectRelayCore(
  deps: ConnectRelayDeps,
  rawUrl: string,
  token?: string,
): Promise<ToolOutcome> {
  const url = rawUrl.trim()
  const decision = validateRelayUrl(url, getAllowedRelayHosts())
  if (!decision.ok) {
    log.warn("connect_relay:refused", { url, code: decision.code })
    return {
      title: "refused",
      output: `connect_relay error: ${decision.message}. ${remediationFor(decision, url)}`,
    }
  }
  try {
    const effectiveToken = token ?? getRelayToken() ?? undefined
    let weakNotice = ""
    // Weak-token warning (W1-U2c item G): a short explicit/env/config token
    // is warned about loudly but still used (never warn-then-refuse).
    // Generated 256-bit tokens never qualify; the token value is never logged.
    if (effectiveToken !== undefined && isWeakRelayToken(effectiveToken)) {
      log.warn("connect_relay:weak-token", {
        detail: `token is shorter than ${MIN_RECOMMENDED_TOKEN_CHARS} chars; generated tokens are 256-bit; prefer the env or token-file channels over short shared secrets`,
      })
      weakNotice = ` Warning: the relay token is shorter than ${MIN_RECOMMENDED_TOKEN_CHARS} characters; generated tokens are 256-bit and are preferred.`
    }
    const { RelayTransport } = await import("../transport/relay.ts")
    await deps.transport.switchTo(new RelayTransport(url, effectiveToken))
    await writeRelayUrl(url, token)
    deps.setLastKnownUrl(url)
    log.info("connect_relay:ok", { url })
    return {
      title: "connected",
      output: `Connected to relay: ${url}.${weakNotice}`,
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
      "Security: the relay host must be in the operator's allowedRelayHosts config and https is enforced " +
      "(http only for loopback/localhost); disallowed URLs are refused with remediation guidance. " +
      "Takes effect immediately (no restart needed) and persists across restarts.",
    args: {
      url: tool.schema
        .string()
        .min(5)
        .describe(
          "HTTP URL of the relay server (e.g. https://relay.example.com:7351). Must be operator-allowlisted.",
        ),
      token: tool.schema
        .string()
        .optional()
        .describe(
          "Shared relay token (Authorization bearer). Omit to reuse the stored token.",
        ),
    },
    async execute(args) {
      return connectRelayCore(deps, args.url, args.token)
    },
  })
}
