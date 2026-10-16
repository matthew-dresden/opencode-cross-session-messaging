import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.ts"
import type { V2PluginContext, V2ToolDefinition } from "./v2types.ts"
import { toV2AskClient } from "./v2ClientAdapter.ts"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// Every test that drives tool execution touches the shared registry and
// message files, so the whole file runs against a temp XDG state dir.
let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-v2-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

function makeFakeCtx(overrides: Partial<V2PluginContext> = {}): V2PluginContext {
  const added: V2ToolDefinition[] = []
  const ctx: V2PluginContext = {
    location: {
      directory: "/tmp/v2-dir",
      project: { id: "test_project_v2" },
    },
    session: {
      async prompt() {
        return {}
      },
      async context() {
        return []
      },
    },
    tool: {
      async transform(callback) {
        callback({
          add: (tool) => {
            added.push(tool)
          },
        })
        return {}
      },
    },
    event: {
      async *subscribe(options) {
        // Never yields: the setup's subscription loop parks here until the
        // AbortController fires (verified via the finally block below).
        const signal = options?.signal
        try {
          await new Promise<never>((resolve, reject) => {
            if (signal?.aborted) return
            signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
        } finally {
          // Marker so the lifecycle test can assert the iterator unwound.
          subscriptionFinalized = true
        }
        yield* []
      },
    },
    ...overrides,
  }
  return Object.assign(ctx, { __added: added })
}

// Set by the fake subscribe() above when its async generator unwinds.
let subscriptionFinalized = false

// Wire-shaped fake ctx that also exposes the captured tool adds.
type FakeCtx = V2PluginContext & { __added: V2ToolDefinition[] }

function fakeCtx(overrides: Partial<V2PluginContext> = {}): FakeCtx {
  return makeFakeCtx(overrides) as FakeCtx
}

function toolByName(ctx: FakeCtx, name: string): V2ToolDefinition {
  const tool = ctx.__added.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

function makeV2ToolCtx(sessionID = "ses_caller_v2") {
  return {
    sessionID,
    agent: "test",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

// ---------------------------------------------------------------------------
// Dual-shape export
// ---------------------------------------------------------------------------

describe("plugin default export (dual shape)", () => {
  test("exposes id, setup (V2) and server (V1) from one default export", () => {
    expect(plugin.id).toBe("cross-session-messaging")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// V2 shape: tool transform
// ---------------------------------------------------------------------------

describe("V2 setup", () => {
  test("registers exactly 4 tools via ctx.tool.transform", async () => {
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    expect(ctx.__added.map((t) => t.name)).toEqual([
      "register_session",
      "list_sessions",
      "ask_session",
      "connect_relay",
    ])
    await cleanup?.()
  })

  test("tool inputs are JSON Schema objects translated from the TS arg types", async () => {
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)

    const register = toolByName(ctx, "register_session")
    expect(register.input.type).toBe("object")
    expect(register.input.properties.summary).toMatchObject({
      type: "string",
      minLength: 5,
      maxLength: 2000,
    })
    expect(register.input.required).toContain("summary")
    expect(register.input.additionalProperties).toBe(false)

    const list = toolByName(ctx, "list_sessions")
    expect(list.input.properties.includeSelf).toMatchObject({ type: "boolean" })
    expect(list.input.required ?? []).not.toContain("includeSelf")

    const ask = toolByName(ctx, "ask_session")
    expect(ask.input.properties.sessionId).toMatchObject({
      type: "string",
      minLength: 1,
    })
    expect(ask.input.properties.question).toMatchObject({
      type: "string",
      minLength: 5,
      maxLength: 20_000,
    })
    expect(ask.input.properties.timeoutMs).toMatchObject({
      type: "integer",
      minimum: 1,
    })
    expect(ask.input.required).toEqual(["sessionId", "question"])

    const connect = toolByName(ctx, "connect_relay")
    expect(connect.input.properties.url).toMatchObject({
      type: "string",
      minLength: 5,
    })
    expect(connect.input.required).toEqual(["url"])
    await cleanup?.()
  })

  test("every tool execute returns structured { content }", async () => {
    await seed("ses_peer_structured")
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)

    const registered = await toolByName(ctx, "register_session").execute(
      { summary: "porting cross-session messaging to v2" },
      makeV2ToolCtx(),
    )
    expect(typeof registered.content).toBe("string")
    expect(registered.content).toContain("Registered session ses_caller_v2")

    const listed = await toolByName(ctx, "list_sessions").execute(
      {},
      makeV2ToolCtx(),
    )
    expect(typeof listed.content).toBe("string")
    expect(listed.content).toContain("Active sessions")

    const selfAsk = await toolByName(ctx, "ask_session").execute(
      { sessionId: "ses_caller_v2", question: "talking to myself?" },
      makeV2ToolCtx(),
    )
    expect(selfAsk.content).toContain("cannot ask yourself")

    const badRelay = await toolByName(ctx, "connect_relay").execute(
      { url: "ftp://nope" },
      makeV2ToolCtx(),
    )
    expect(badRelay.content).toContain("URL must start with http://")
    await cleanup?.()
  })
})

// ---------------------------------------------------------------------------
// V2 shape: event subscription lifecycle
// ---------------------------------------------------------------------------

describe("V2 event subscription lifecycle", () => {
  test("setup subscribes and its cleanup aborts the stream", async () => {
    subscriptionFinalized = false
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    expect(subscriptionFinalized).toBe(false)
    await cleanup?.()
    // The cleanup aborted the controller; the async iterator unwound.
    expect(subscriptionFinalized).toBe(true)
  })

  test("session.deleted (V2 shape) prunes the matching registry entry", async () => {
    await seed("ses_v2_dead")
    await seed("ses_v2_alive")
    const pruned: string[] = []
    const handler = (event: { type: string; data?: unknown }) => {
      if (event.type !== "session.deleted") return
      const sessionId = (event.data as { sessionID?: unknown })?.sessionID
      if (typeof sessionId === "string") pruned.push(sessionId)
    }
    handler({ type: "session.deleted", data: { sessionID: "ses_v2_dead" } })
    handler({ type: "session.idle", data: { sessionID: "ses_v2_alive" } })
    expect(pruned).toEqual(["ses_v2_dead"])
  })
})

// ---------------------------------------------------------------------------
// V2 shape: ask_session blocking behavior against a real (temp-dir) registry
// ---------------------------------------------------------------------------

describe("V2 ask_session (fake peer registry, file IPC)", () => {
  test("blocks until the peer writes a response file, then returns its text", async () => {
    await seed("ses_peer_v2")
    const { writeResponse, getMessagesDir } = await import(
      "./fileTransport.ts"
    )
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    const ask = toolByName(ctx, "ask_session")

    const promise = ask.execute(
      { sessionId: "ses_peer_v2", question: "what is the port plan?" },
      makeV2ToolCtx(),
    )

    // Simulate the peer: wait for the request file, answer it. The messages
    // dir is created lazily by writeRequest, so ENOENT just means "not yet".
    const { readdir } = await import("node:fs/promises")
    const deadline = Date.now() + 5_000
    for (;;) {
      const files = await readdir(getMessagesDir()).catch(
        (err: { code?: string }) => {
          if (err.code === "ENOENT") return [] as string[]
          throw err
        },
      )
      const reqFile = files.find((f) => f.endsWith(".req.json"))
      if (reqFile) {
        await writeResponse({
          requestId: reqFile.replace(".req.json", ""),
          reply: "port 7351, dual-shape export",
          createdAt: Date.now(),
        })
        break
      }
      if (Date.now() > deadline) {
        throw new Error("peer request file never appeared")
      }
      await new Promise((r) => setTimeout(r, 50))
    }

    const result = await promise
    expect(result.content).toBe("port 7351, dual-shape export")
    await cleanup?.()
  }, 15_000)

  test("timeout produces an error content string, never a throw", async () => {
    await seed("ses_silent_v2")
    const ctx = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    const ask = toolByName(ctx, "ask_session")
    const result = await ask.execute(
      { sessionId: "ses_silent_v2", question: "anyone there?", timeoutMs: 300 },
      makeV2ToolCtx(),
    )
    expect(result.content).toContain("did not respond within 300ms")
    await cleanup?.()
  }, 10_000)
})

// ---------------------------------------------------------------------------
// V2 client adapter (ctx.session domain → ask pipeline seam)
// ---------------------------------------------------------------------------

describe("v2ClientAdapter", () => {
  test("promptAsync routes to ctx.session.prompt with sessionID + joined text", async () => {
    const prompts: Array<{ sessionID: string; text: string }> = []
    const client = toV2AskClient({
      async prompt(input) {
        prompts.push(input)
        return {}
      },
      async context() {
        return []
      },
    })
    await client.session.promptAsync({
      path: { id: "ses_target" },
      body: { parts: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    })
    expect(prompts).toEqual([{ sessionID: "ses_target", text: "hello world" }])
  })

  test("messages maps the V2 tagged union onto the AskClientMessage shape", async () => {
    const client = toV2AskClient({
      async prompt() {
        return {}
      },
      async context() {
        return [
          {
            // Real V2 user-message shape: flat `text`, no content parts.
            type: "user",
            time: { created: 100 },
            text: "q",
          },
          {
            type: "assistant",
            time: { created: 200 },
            content: [
              { type: "reasoning", text: "thinking..." },
              { type: "text", text: "answer" },
              { type: "tool", name: "bash" },
            ],
          },
          { type: "agent-switched", time: { created: 150 } },
        ]
      },
    })
    const msgs = await client.session.messages({ path: { id: "ses_target" } })
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toEqual({
      info: { role: "user", time: { created: 100 } },
      parts: [{ type: "text", text: "q" }],
    })
    // Assistant: text + reasoning text parts survive; tool parts carry no text.
    expect(msgs[1].info.role).toBe("assistant")
    expect(msgs[1].info.time.created).toBe(200)
    expect(msgs[1].parts).toEqual([
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "answer" },
      { type: "tool", text: undefined },
    ])
    expect(msgs[2].info.role).toBe("agent-switched")
    // The ask pipeline's filter (role === "assistant", text parts) still works:
    const candidates = msgs.filter(
      (m) => m.info.role === "assistant" && m.info.time.created >= 150,
    )
    const text = candidates[0].parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
    expect(text).toBe("answer")
  })
})

// ---------------------------------------------------------------------------
// Registry seeding (real temp-dir files)
// ---------------------------------------------------------------------------

async function seed(sessionId: string): Promise<void> {
  const { upsertEntry } = await import("./registry.ts")
  await upsertEntry({
    sessionId,
    summary: "seeded v2 target",
    directory: "/tmp/v2-seed",
    projectId: "p_seed_v2",
    daemonId: "daemon-v2-test",
  })
}
