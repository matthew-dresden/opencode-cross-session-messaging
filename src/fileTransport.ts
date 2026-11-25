import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { abortableSleep } from "./abort.ts"
import { MESSAGES_DIR_NAME, RESPONSE_POLL_MS } from "./constants.ts"
import { AskTimeoutError } from "./types.ts"
import { getStateDir } from "./xdg.ts"

export function getMessagesDir(): string {
  return join(getStateDir(), MESSAGES_DIR_NAME)
}

export interface FileRequest {
  requestId: string
  toSessionId: string
  question: string
  createdAt: number
}

export interface FileResponse {
  requestId: string
  reply?: string
  error?: string
  createdAt: number
}

export async function writeRequest(req: FileRequest): Promise<void> {
  const path = join(getMessagesDir(), `${req.requestId}.req.json`)
  await writeAtomic(path, JSON.stringify(req))
}

export async function readRequest(path: string): Promise<FileRequest | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as FileRequest
  } catch {
    return null
  }
}

export async function writeResponse(res: FileResponse): Promise<void> {
  const path = join(getMessagesDir(), `${res.requestId}.res.json`)
  await writeAtomic(path, JSON.stringify(res))
}

export async function pollForResponse(
  requestId: string,
  toSessionId: string,
  opts: { timeoutMs: number; abort?: AbortSignal },
): Promise<FileResponse> {
  const resPath = join(getMessagesDir(), `${requestId}.res.json`)
  const start = Date.now()
  while (true) {
    if (opts.abort?.aborted) {
      const err = new Error("Aborted")
      err.name = "AbortError"
      throw err
    }
    try {
      const raw = await fs.readFile(resPath, "utf8")
      return JSON.parse(raw) as FileResponse
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "ENOENT") throw err
    }
    if (Date.now() - start >= opts.timeoutMs) {
      throw new AskTimeoutError(toSessionId, opts.timeoutMs)
    }
    await abortableSleep(RESPONSE_POLL_MS, opts.abort)
  }
}

export async function cleanupRequest(requestId: string): Promise<void> {
  const dir = getMessagesDir()
  await fs.unlink(join(dir, `${requestId}.req.json`)).catch(() => {})
  await fs.unlink(join(dir, `${requestId}.res.json`)).catch(() => {})
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, content, {
      encoding: "utf8",
      // Security remediation 2026-11: request/response files carry questions
      // and replies, so they are owner-only (0600) from creation (W1-U2c
      // item C: mode at creation, chmod kept as belt-and-braces).
      mode: 0o600,
    })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}
