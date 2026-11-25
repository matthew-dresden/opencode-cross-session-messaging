import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AskTimeoutError } from "./types.ts"
import {
  cleanupRequest,
  getMessagesDir,
  pollForResponse,
  readRequest,
  writeRequest,
  writeResponse,
} from "./fileTransport.ts"

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-filetransport-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

describe("fileTransport", () => {
  test("writeRequest creates atomic .req.json with correct contents", async () => {
    await writeRequest({
      requestId: "r1",
      toSessionId: "ses_b",
      question: "hello",
      createdAt: 1000,
    })
    const raw = await readFile(
      join(getMessagesDir(), "r1.req.json"),
      "utf8",
    )
    const parsed = JSON.parse(raw)
    expect(parsed.requestId).toBe("r1")
    expect(parsed.toSessionId).toBe("ses_b")
    expect(parsed.question).toBe("hello")
  })

  test("readRequest returns parsed object or null on missing file", async () => {
    await writeRequest({
      requestId: "r2",
      toSessionId: "ses_b",
      question: "hi",
      createdAt: 1000,
    })
    const req = await readRequest(join(getMessagesDir(), "r2.req.json"))
    expect(req?.requestId).toBe("r2")

    const missing = await readRequest("/tmp/nonexistent-xsm-file.json")
    expect(missing).toBeNull()
  })

  test("writeResponse + pollForResponse round-trip", async () => {
    await writeResponse({
      requestId: "r3",
      reply: "42",
      createdAt: 2000,
    })
    const res = await pollForResponse("r3", "ses_x", {
      timeoutMs: 1000,
    })
    expect(res.reply).toBe("42")
  })

  test("pollForResponse waits for late response file", async () => {
    setTimeout(async () => {
      await writeResponse({
        requestId: "r4",
        reply: "delayed",
        createdAt: 2000,
      })
    }, 200)
    const res = await pollForResponse("r4", "ses_x", {
      timeoutMs: 2000,
    })
    expect(res.reply).toBe("delayed")
  })

  test("pollForResponse throws AskTimeoutError when file never appears", async () => {
    let caught: Error | undefined
    try {
      await pollForResponse("r_never", "ses_x", { timeoutMs: 200 })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AskTimeoutError)
  })

  test("pollForResponse respects abort signal", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    let caught: Error | undefined
    try {
      await pollForResponse("r_abort", "ses_x", {
        timeoutMs: 5000,
        abort: ctrl.signal,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.name).toBe("AbortError")
  })

  test("cleanupRequest removes both req and res files", async () => {
    await writeRequest({
      requestId: "r5",
      toSessionId: "ses_b",
      question: "hi",
      createdAt: 1000,
    })
    await writeResponse({ requestId: "r5", reply: "bye", createdAt: 2000 })
    await cleanupRequest("r5")
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(getMessagesDir())
    expect(files.filter((f) => f.startsWith("r5"))).toHaveLength(0)
  })

  test("written request/response files are 0600 (owner-only)", async () => {
    const { stat } = await import("node:fs/promises")
    await writeRequest({
      requestId: "r6",
      toSessionId: "ses_b",
      question: "private question text",
      createdAt: 1000,
    })
    await writeResponse({ requestId: "r6", reply: "private reply text", createdAt: 2000 })
    const reqStat = await stat(join(getMessagesDir(), "r6.req.json"))
    const resStat = await stat(join(getMessagesDir(), "r6.res.json"))
    expect(reqStat.mode & 0o777).toBe(0o600)
    expect(resStat.mode & 0o777).toBe(0o600)
  })
})
