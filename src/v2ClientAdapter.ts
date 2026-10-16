import type { AskClient, AskClientMessage } from "./askAndWaitForReply.ts"
import type { V2SessionDomain } from "./v2types.ts"

/**
 * Adapter from the opencode V2 plugin context's session domain
 * (`ctx.session.prompt` / `ctx.session.context`) to the polling ask pipeline's
 * `AskClient` seam (`session.promptAsync` / `session.messages`).
 *
 * This replaces the V1 SDK client wiring (story 2.4 / audit R11): the V1
 * `client.session.promptAsync` and `client.session.messages` REST shapes do
 * not exist on the V2 context, which exposes domain methods instead.
 *
 * V2 message model (verified against `@opencode/plugin` 2.0.30 /
 * `@opencode/client` generated types):
 * - `ctx.session.prompt({ sessionID, text })` admits a user prompt and
 *   resolves once it is admitted (the V1 `promptAsync` equivalent).
 * - `ctx.session.context({ sessionID })` returns `SessionMessageInfo[]`, a
 *   tagged union. Assistant entries are `{ type: "assistant", time: { created:
 *   number }, content: Array<{ type: "text" | "reasoning" | "tool", ... }> }`.
 *   Text and reasoning parts carry `text`; tool parts do not.
 */

/** Structural subset of a V2 `SessionMessageInfo` the adapter reads. */
export interface V2MessageLike {
  type?: unknown
  time?: { created?: unknown }
  /** User messages carry flat `text`; assistant messages carry `content` parts. */
  text?: unknown
  content?: ReadonlyArray<{ type?: unknown; text?: unknown }>
}

export function toV2AskClient(session: V2SessionDomain): AskClient {
  return {
    session: {
      async promptAsync(args) {
        const text = args.body.parts
          .map((p) => p.text)
          .join("")
        await session.prompt({
          sessionID: args.path.id,
          text,
        })
      },
      async messages(args) {
        const items = await session.context({
          sessionID: args.path.id,
        })
        return items.map(toAskClientMessage)
      },
    },
  }
}

export function toAskClientMessage(raw: unknown): AskClientMessage {
  const msg = (raw ?? {}) as V2MessageLike
  const created = msg.time?.created
  return {
    info: {
      role: messageRole(msg.type),
      time: {
        created:
          typeof created === "number"
            ? created
            : typeof created === "string" && created !== ""
              ? Number(created)
              : 0,
      },
    },
    parts:
      msg.type === "user"
        ? userTextParts(msg.text)
        : messageTextParts(msg.content),
  }
}

function messageRole(type: unknown): string {
  if (type === "user") return "user"
  if (type === "assistant") return "assistant"
  return typeof type === "string" && type.length > 0 ? type : "unknown"
}

function messageTextParts(
  content: V2MessageLike["content"],
): AskClientMessage["parts"] {
  if (!Array.isArray(content)) return []
  return content.map((part) => ({
    type: typeof part?.type === "string" ? part.type : "unknown",
    text: part?.type === "text" || part?.type === "reasoning"
      ? typeof part.text === "string"
        ? part.text
        : undefined
      : undefined,
  }))
}

function userTextParts(text: unknown): AskClientMessage["parts"] {
  return [
    {
      type: "text",
      text: typeof text === "string" ? text : undefined,
    },
  ]
}
