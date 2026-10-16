import { log } from "./logger.ts"
import type { ITransport } from "./transport/interface.ts"
import type { V2Event } from "./v2types.ts"

type EventInput = { event: { type?: string; properties?: unknown } }

/**
 * Remove one session's registry entry, logging (never throwing) on failure.
 *
 * Amendment-9 discipline: registry pruning on session deletion is
 * non-essential hygiene (STALE_ENTRY_TTL_MS is the defense-in-depth backstop
 * for a missed event), so failures are logged and the caller proceeds.
 */
export async function pruneSessionEntry(
  transport: ITransport,
  sessionId: string,
): Promise<boolean> {
  try {
    const removed = await transport.remove(sessionId)
    log.info("event:session-deleted", { sessionId, removed })
    return removed
  } catch (err: unknown) {
    log.warn("event:session-deleted-cleanup-fail", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/** V1 event hook (`{ event: { type, properties } }` wire shape). */
export function createEventHandler(
  transport: ITransport,
): (input: EventInput) => Promise<void> {
  return async ({ event }) => {
    if (event.type !== "session.deleted") return
    const props = event.properties as { info?: { id?: unknown } } | undefined
    const sessionId = props?.info?.id
    if (typeof sessionId !== "string" || sessionId.length === 0) return
    await pruneSessionEntry(transport, sessionId)
  }
}

/**
 * Extract the deleted session's ID from a V2 `session.deleted` event.
 *
 * V2 wire shape (verified against `@opencode/schema` 2.0.30):
 * `{ type: "session.deleted", data: { sessionID: string } }` — the V1 shape
 * (`properties.info.id`) does not exist on the V2 stream.
 */
export function v2DeletedSessionId(event: V2Event): string | null {
  if (event.type !== "session.deleted") return null
  const data = event.data as { sessionID?: unknown } | undefined
  const sessionId = data?.sessionID
  if (typeof sessionId !== "string" || sessionId.length === 0) return null
  return sessionId
}

/**
 * Consume the V2 server event stream until aborted, pruning registry entries
 * on `session.deleted`.
 *
 * Amendment-9 discipline: per-event failures (and stream failures) are logged
 * and the loop proceeds/exits without throwing — the subscription is
 * non-essential to the relay and ask paths.
 */
export async function runV2EventSubscription(
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event>,
  transport: ITransport,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of subscribe({ signal })) {
      if (signal.aborted) return
      try {
        const sessionId = v2DeletedSessionId(event)
        if (sessionId === null) continue
        await pruneSessionEntry(transport, sessionId)
      } catch (err: unknown) {
        log.warn("event:v2-handler-fail", {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err: unknown) {
    if (signal.aborted) {
      log.info("event:v2-stream-aborted")
      return
    }
    log.warn("event:v2-stream-fail", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
