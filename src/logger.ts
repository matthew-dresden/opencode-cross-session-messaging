import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { PLUGIN_ID } from "./constants.ts"
import { getStateDir } from "./xdg.ts"

type Client = PluginInput["client"]
type Level = "debug" | "info" | "warn" | "error"

let client: Client | null = null
let logPath: string | null = null

function getLogPath(): string {
  if (!logPath) {
    logPath = join(getStateDir(), "cross-session-messaging.log")
    mkdirSync(dirname(logPath), { recursive: true })
  }
  return logPath
}

/** The V2 setup path passes null — the V2 logger is file-only (`void client`). */
export function initLogger(c: Client | null): void {
  client = c
}

function emit(level: Level, tag: string, extra?: unknown): void {
  const payload = extra === undefined ? "" : ` ${safeStringify(extra)}`
  const ts = new Date().toISOString()
  const line = `${ts} [${level}] ${PLUGIN_ID}: ${tag}${payload}\n`
  try {
    appendFileSync(getLogPath(), line)
  } catch {
    /* ignore write failures */
  }
  void client
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function getLogFilePath(): string {
  return getLogPath()
}

export const log = {
  debug: (tag: string, extra?: unknown): void => emit("debug", tag, extra),
  info: (tag: string, extra?: unknown): void => emit("info", tag, extra),
  warn: (tag: string, extra?: unknown): void => emit("warn", tag, extra),
  error: (tag: string, extra?: unknown): void => emit("error", tag, extra),
}
