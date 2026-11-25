import { describe, expect, test } from "bun:test"
import {
  hostMatchesAllowlist,
  isLoopbackHost,
  validateRelayUrl,
} from "./relayPolicy.ts"

describe("isLoopbackHost", () => {
  test("recognizes loopback hostnames and IPv4/IPv6 loopback", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.220.1.9",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  test("rejects non-loopback hosts, including the unspecified address", () => {
    for (const host of [
      "example.com",
      "relay.local",
      "10.0.0.5",
      "192.168.1.100",
      "172.16.0.1",
      "0.0.0.0",
      "[::]",
      "::",
      "",
    ]) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe("hostMatchesAllowlist", () => {
  const url = (u: string): URL => new URL(u)

  test("entry without port matches any port on that hostname", () => {
    expect(
      hostMatchesAllowlist(["relay.example.test"], url("https://relay.example.test:7351")),
    ).toBe(true)
    expect(
      hostMatchesAllowlist(["relay.example.test"], url("https://relay.example.test:9999")),
    ).toBe(true)
  })

  test("entry with port matches only that exact host and port", () => {
    expect(
      hostMatchesAllowlist(
        ["relay.example.test:7351"],
        url("https://relay.example.test:7351"),
      ),
    ).toBe(true)
    expect(
      hostMatchesAllowlist(
        ["relay.example.test:7351"],
        url("https://relay.example.test:9999"),
      ),
    ).toBe(false)
  })

  test("matching is case-insensitive", () => {
    expect(
      hostMatchesAllowlist(
        ["RELAY.EXAMPLE.TEST:7351"],
        url("https://relay.example.test:7351"),
      ),
    ).toBe(true)
  })

  test("different hostnames never match", () => {
    expect(
      hostMatchesAllowlist(
        ["other.example.test"],
        url("https://relay.example.test:7351"),
      ),
    ).toBe(false)
  })

  test("an entry pinned to the scheme-default port matches a port-less URL", () => {
    // URL.port normalizes default ports to "", so the comparison must use
    // effective ports on both sides.
    expect(
      hostMatchesAllowlist(
        ["collector.example.test:443"],
        url("https://collector.example.test"),
      ),
    ).toBe(true)
    expect(
      hostMatchesAllowlist(
        ["collector.example.test:80"],
        url("http://collector.example.test"),
      ),
    ).toBe(true)
  })

  test("a default-port entry never matches a different effective port", () => {
    expect(
      hostMatchesAllowlist(
        ["collector.example.test:443"],
        url("https://collector.example.test:8443"),
      ),
    ).toBe(false)
    expect(
      hostMatchesAllowlist(
        ["collector.example.test:80"],
        url("https://collector.example.test"),
      ),
    ).toBe(false)
  })
})

describe("validateRelayUrl", () => {
  const ALLOWED = ["relay.example.test:7351", "anyport.example.test"]

  test("https allowlisted host passes", () => {
    const d = validateRelayUrl("https://relay.example.test:7351", ALLOWED)
    expect(d.ok).toBe(true)
  })

  test("http loopback host passes when allowlisted", () => {
    const d = validateRelayUrl("http://127.0.0.1:7351", ["127.0.0.1"])
    expect(d.ok).toBe(true)
  })

  test("http loopback by hostname passes when allowlisted", () => {
    const d = validateRelayUrl("http://localhost:7351", ["localhost"])
    expect(d.ok).toBe(true)
  })

  test("non-loopback http is refused with an https remediation", () => {
    const d = validateRelayUrl("http://relay.example.test:7351", ALLOWED)
    expect(d.ok).toBe(false)
    expect(d.code).toBe("scheme")
    expect(d.message).toMatch(/https/i)
  })

  test("empty allowlist refuses every relay, even a valid https URL", () => {
    const d = validateRelayUrl("https://relay.example.test:7351", [])
    expect(d.ok).toBe(false)
    expect(d.code).toBe("empty-allowlist")
    expect(d.message).toMatch(/allowedRelayHosts/)
  })

  test("missing allowlist (undefined) refuses like an empty one", () => {
    const d = validateRelayUrl("https://relay.example.test:7351", undefined)
    expect(d.ok).toBe(false)
    expect(d.code).toBe("empty-allowlist")
  })

  test("unallowlisted host is refused and names the host", () => {
    const d = validateRelayUrl("https://collector.example.test:443", ALLOWED)
    expect(d.ok).toBe(false)
    expect(d.code).toBe("not-allowed")
    expect(d.message).toContain("collector.example.test:443")
    expect(d.message).toMatch(/allowedRelayHosts/)
  })

  test("allowlist entry without port accepts any port on that host", () => {
    const d = validateRelayUrl("https://anyport.example.test:9999", ALLOWED)
    expect(d.ok).toBe(true)
  })

  test("allowlist entry pinned to 443 admits the port-less https URL", () => {
    const d = validateRelayUrl("https://collector.example.test", [
      "collector.example.test:443",
    ])
    expect(d.ok).toBe(true)
  })

  test("non-http(s) scheme is refused", () => {
    const d = validateRelayUrl("ftp://relay.example.test", ALLOWED)
    expect(d.ok).toBe(false)
    expect(d.code).toBe("invalid")
  })

  test("garbage input is refused as invalid", () => {
    const d = validateRelayUrl("not a url", ALLOWED)
    expect(d.ok).toBe(false)
    expect(d.code).toBe("invalid")
  })
})
