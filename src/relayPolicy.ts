/**
 * Relay URL policy (security remediation 2026-11).
 *
 * Pure functions, no filesystem access, so the same gate applies everywhere a
 * relay URL is honored: the connect_relay tool, plugin init, and the config
 * poller. Policy:
 *   - https is the default transport; plaintext http is allowed only for
 *     loopback/localhost relays (operator hand-edits that force non-loopback
 *     http get a loud warning from RelayTransport instead of a silent pass).
 *   - an operator-configured host allowlist gates every connect: an empty
 *     allowlist refuses every relay with a typed remediation message.
 */

export type RelayUrlIssueCode =
  | "invalid"
  | "scheme"
  | "empty-allowlist"
  | "not-allowed"

export interface RelayUrlDecision {
  ok: boolean
  code?: RelayUrlIssueCode
  /** Human/model-readable reason; set only when ok is false. */
  message?: string
}

/** True only for real loopback targets; the unspecified address (0.0.0.0 / ::) is NOT loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  return host === "localhost" || host === "::1" || host.startsWith("127.")
}

function splitHostPort(entry: string): { host: string; port: string | null } {
  const trimmed = entry.trim()
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]")
    if (close !== -1) {
      const host = trimmed.slice(0, close + 1)
      const rest = trimmed.slice(close + 1)
      const port = rest.startsWith(":") ? rest.slice(1) : null
      return { host, port }
    }
  }
  const lastColon = trimmed.lastIndexOf(":")
  if (lastColon !== -1 && !trimmed.includes("]:")) {
    return {
      host: trimmed.slice(0, lastColon),
      port: trimmed.slice(lastColon + 1),
    }
  }
  return { host: trimmed, port: null }
}

/**
 * A port rendered to its effective value: an absent port resolves to the
 * scheme default (https 443, http 80), so "host:443" entries and port-less
 * https URLs compare equal. Unknown schemes have no default; an empty
 * string matches only another empty string.
 */
function effectivePort(
  port: string | null | undefined,
  protocol: string,
): string {
  if (port !== null && port !== undefined && port !== "") return port
  if (protocol === "https:") return "443"
  if (protocol === "http:") return "80"
  return ""
}

/**
 * Allowlist match: an entry without a port matches any port on that hostname;
 * an entry with a port matches that exact host plus its effective port
 * (W1-U2c item D: an entry pinned to a scheme-default port such as
 * "host:443" also matches a port-less https URL, because URL.port
 * normalizes default ports to ""). Case-insensitive.
 */
export function hostMatchesAllowlist(allowed: string[], url: URL): boolean {
  const urlHost = url.hostname.toLowerCase()
  const urlPort = effectivePort(url.port, url.protocol)
  for (const entry of allowed) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const { host, port } = splitHostPort(trimmed)
    const entryHost = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
    if (entryHost !== urlHost) continue
    if (port !== null && effectivePort(port, url.protocol) !== urlPort) continue
    return true
  }
  return false
}

/**
 * The refusal-message form of a URL's authority: hostname plus the effective
 * port, where an omitted port resolves to the scheme default (https 443,
 * http 80). `url.host` drops default ports, so an explicit
 * `https://host:443` URL would otherwise be named without its port in
 * refusals and the operator could not tell which exact endpoint was meant.
 */
function displayHostPort(url: URL): string {
  const port = effectivePort(url.port, url.protocol)
  return port ? `${url.hostname}:${port}` : url.hostname
}

/**
 * The single gate applied to every relay URL before it is honored or
 * persisted. `allowedHosts` comes from the operator's config file
 * (`allowedRelayHosts`); an undefined/empty list refuses everything.
 */
export function validateRelayUrl(
  rawUrl: string,
  allowedHosts: string[] | undefined,
): RelayUrlDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return {
      ok: false,
      code: "invalid",
      message: `not a valid relay URL: ${rawUrl}`,
    }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "invalid",
      message: "relay URL must start with http:// or https://",
    }
  }

  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      code: "scheme",
      message: `plaintext http is only permitted for loopback/localhost relays; use https for ${url.host}`,
    }
  }

  const allowed = (allowedHosts ?? []).map((h) => h.trim()).filter((h) => h.length > 0)
  if (allowed.length === 0) {
    return {
      ok: false,
      code: "empty-allowlist",
      message:
        "no relay host allowlist is configured (allowedRelayHosts); every connect_relay call is refused until the operator allowlists relay hosts",
    }
  }

  if (!hostMatchesAllowlist(allowed, url)) {
    return {
      ok: false,
      code: "not-allowed",
      message: `relay host ${displayHostPort(url)} is not in allowedRelayHosts`,
    }
  }

  return { ok: true }
}
