import { afterEach, describe, expect, test } from "bun:test"
import type { AskCreatedEvent } from "./core.ts"
import { QUESTION_PREVIEW_LEN, RelayCore } from "./core.ts"

const SECRET_QUESTION = "SECRET-QUESTION-CONTENT-that-must-not-leak"

function makeCore(opts?: { previews?: boolean }): RelayCore {
  const core = new RelayCore(opts)
  core.touchClient("caller-client", "127.0.0.1")
  core.touchClient("target-client", "127.0.0.2")
  core.register("target-client", {
    sessionId: "ses_target",
    summary: "target",
    directory: "/tmp",
    projectId: "p1",
  })
  return core
}

const lastTestCore: { current: RelayCore | null } = { current: null }

afterEach(() => {
  lastTestCore.current?.dispose()
  lastTestCore.current = null
})

function track(core: RelayCore): RelayCore {
  lastTestCore.current = core
  return core
}

function onceEvent<T>(core: RelayCore, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`event ${event} not emitted within timeout`)),
      4000,
    )
    core.once(event, (data: unknown) => {
      clearTimeout(timer)
      resolve(data as T)
    })
  })
}

describe("RelayCore preview privacy", () => {
  test("ask:created carries no question preview by default", async () => {
    const core = track(makeCore())
    const evtP = onceEvent<AskCreatedEvent>(core, "ask:created")
    core.ask("caller-client", {
      requestId: "req-privacy-1",
      toSessionId: "ses_target",
      question: SECRET_QUESTION,
      timeoutMs: 1000,
    })
    const evt = await evtP
    expect(evt.questionPreview).toBe("")
    expect(evt.requestId).toBe("req-privacy-1")
    expect(evt.fromSessionId).toBe("ses_target")
    expect(evt.toSessionId).toBe("ses_target")
  })

  test("snapshot activity carries no question content by default", () => {
    const core = track(makeCore())
    core.ask("caller-client", {
      requestId: "req-privacy-2",
      toSessionId: "ses_target",
      question: SECRET_QUESTION,
      timeoutMs: 1000,
    })
    const snapshot = JSON.stringify(core.getSnapshot())
    expect(snapshot).not.toContain("SECRET-QUESTION-CONTENT")
  })

  test("previews opt-in: the 200-char preview is broadcast again", async () => {
    const core = track(makeCore({ previews: true }))
    const evtP = onceEvent<AskCreatedEvent>(core, "ask:created")
    core.ask("caller-client", {
      requestId: "req-privacy-3",
      toSessionId: "ses_target",
      question: SECRET_QUESTION,
      timeoutMs: 1000,
    })
    const evt = await evtP
    expect(evt.questionPreview).toBe(
      SECRET_QUESTION.slice(0, QUESTION_PREVIEW_LEN),
    )
  })

  test("question delivery to the target client is unaffected by the privacy gate", () => {
    const core = track(makeCore())
    core.ask("caller-client", {
      requestId: "req-privacy-4",
      toSessionId: "ses_target",
      question: SECRET_QUESTION,
      timeoutMs: 1000,
    })
    const messages = core.poll("target-client")
    expect(messages).toHaveLength(1)
    const msg = messages[0] as { type: string; question: string }
    expect(msg.type).toBe("inbound")
    expect(msg.question).toBe(SECRET_QUESTION)
  })
})
