#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { RELAY_DEFAULT_PORT } from "../constants.ts"
import type { LogEvent } from "./core.ts"
import { RelayServer } from "./server.ts"
import { relayTokenPath, tokenSourceDescription } from "./token.ts"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: String(RELAY_DEFAULT_PORT) },
    host: { type: "string", short: "h", default: "127.0.0.1" },
    token: { type: "string" },
    previews: { type: "boolean", default: false },
  },
})

const port = Number.parseInt(values.port ?? String(RELAY_DEFAULT_PORT), 10)
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(`Invalid --port value: ${values.port}`)
  process.exit(1)
}

const host = (values.host ?? "127.0.0.1").trim()
if (host.length === 0) {
  console.error("Invalid --host value: must be a non-empty interface address")
  process.exit(1)
}

const server = new RelayServer({
  port,
  host,
  token: values.token,
  previews: values.previews,
})

server.core.on("log", (evt: LogEvent) => {
  const ts = new Date().toISOString()
  console.log(`${ts} [${evt.level}] ${evt.tag}: ${evt.message}`)
})

server.start()

console.log(`Cross-session relay server listening on http://${host}:${port}`)
console.log(`Dashboard: http://localhost:${port}/`)
console.log(
  `(the dashboard prompts once for the relay token and caches it in localStorage)`,
)
console.log(`WebSocket: ws://localhost:${port}/ws?token=<relay-token>`)
console.log(`Auth: /api/*, /stats and /ws require the shared relay token`)
console.log(`Token source: ${tokenSourceDescription({ token: values.token })}`)
console.log(
  `Clients authenticate with "Authorization: Bearer <token>" or "?token=<token>";`,
)
console.log(
  `the token value is in RELAY_TOKEN or the token file: ${relayTokenPath()}`,
)
console.log(
  `Bind: ${host} (loopback by default; pass --host to bind another interface explicitly)`,
)
if (!values.previews) {
  console.log(
    `Privacy: question previews are OFF (broadcasts and the dashboard snapshot carry session ids, task summaries, directories, project ids, device names, client IPs, and timing; question text only with --previews)`,
  )
}

let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`\nReceived ${signal}, shutting down...`)
  server.stop()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
