import { randomUUID } from "node:crypto"
import { RELAY_HTTP_POLL_MS } from "../constants.ts"
import { log } from "../logger.ts"
import { isLoopbackHost } from "../relayPolicy.ts"
import type { ServerMessage } from "../relay/protocol.ts"
import { AskTimeoutError } from "../types.ts"
import type { RegistryEntry } from "../types.ts"
import type { InboxHandler, ITransport } from "./interface.ts"

interface Pending {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

export class RelayTransport implements ITransport {
  private readonly clientId = randomUUID()
  /**
   * Wiring-facing marker (W1-U2d): lets the config poller identify a live
   * relay inner without importing this class.
   */
  readonly kind = "relay" as const
  private disposed = false

  private pending = new Map<string, Pending>()
  private registeredEntries = new Map<
    string,
    Omit<RegistryEntry, "registeredAt" | "updatedAt">
  >()
  private inboxHandler: InboxHandler | null = null

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(
    private readonly relayUrl: string,
    private readonly token?: string,
  ) {
    try {
      const parsed = new URL(relayUrl)
      if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
        log.error("relay:insecure-transport", {
          relayUrl,
          detail:
            "non-loopback plaintext http relay: questions, replies, and registry metadata travel unencrypted in transit; configure an https relay",
        })
      }
    } catch {
      /* invalid URL is surfaced by the policy gate; nothing to warn about here */
    }
    log.info("relay:transport:init", {
      relayUrl,
      clientId: this.clientId.slice(0, 8),
      auth: token ? "bearer" : "none",
    })
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  /**
   * True when this transport already targets exactly this relay URL and
   * effective token (W1-U2d FIX 2). The comparison stays inside the class
   * so the token value never leaves it.
   */
  isTargeting(relayUrl: string, token: string | undefined): boolean {
    return this.relayUrl === relayUrl && this.token === token
  }

  async register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry> {
    this.checkDisposed()
    this.registeredEntries.set(entry.sessionId, entry)
    log.info("relay:register", {
      sessionId: entry.sessionId,
      url: this.relayUrl,
    })

    try {
      const res = (await this.post("/api/register", {
        clientId: this.clientId,
        ...entry,
      })) as ServerMessage

      if (res.type === "registered") {
        log.info("relay:register:ok", { sessionId: entry.sessionId })
        return res.entry
      }
      if (res.type === "error") {
        log.error("relay:register:server-error", { message: res.message })
        throw new Error(res.message)
      }
      log.error("relay:register:unexpected", { type: res.type })
      throw new Error(`Unexpected response: ${res.type}`)
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !err.message.startsWith("Unexpected response")
      ) {
        log.error("relay:register:fail", {
          sessionId: entry.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      throw err
    }
  }

  async list(): Promise<RegistryEntry[]> {
    this.checkDisposed()
    const requestId = randomUUID()
    log.debug("relay:list", { url: this.relayUrl })

    const res = (await this.post("/api/list", {
      clientId: this.clientId,
      requestId,
    })) as ServerMessage

    if (res.type === "sessions") {
      log.debug("relay:list:ok", { count: res.entries.length })
      return res.entries
    }
    if (res.type === "error") {
      log.error("relay:list:server-error", { message: res.message })
      throw new Error(res.message)
    }
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async remove(sessionId: string): Promise<boolean> {
    this.checkDisposed()
    this.registeredEntries.delete(sessionId)
    log.info("relay:remove", { sessionId })

    const res = (await this.post("/api/unregister", {
      clientId: this.clientId,
      sessionId,
    })) as ServerMessage

    if (res.type === "unregistered") {
      log.info("relay:remove:ok", { sessionId, removed: res.removed })
      return res.removed
    }
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async lookup(sessionId: string): Promise<RegistryEntry | null> {
    this.checkDisposed()
    const requestId = randomUUID()
    log.debug("relay:lookup", { sessionId })

    const res = (await this.post("/api/lookup", {
      clientId: this.clientId,
      requestId,
      sessionId,
    })) as ServerMessage

    if (res.type === "looked-up") {
      log.debug("relay:lookup:ok", {
        sessionId,
        found: res.entry !== null,
      })
      return res.entry
    }
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }> {
    this.checkDisposed()
    this.ensurePollStarted()
    const { requestId, toSessionId, question, timeoutMs, abort } = params
    log.info("relay:ask", {
      requestId: requestId.slice(0, 8),
      toSessionId,
      timeoutMs,
      questionLen: question.length,
    })

    return new Promise<{ reply?: string; error?: string }>(
      (resolve, reject) => {
        let abortListener: (() => void) | null = null
        const removeAbortListener = () => {
          if (abortListener && abort) {
            abort.removeEventListener("abort", abortListener)
            abortListener = null
          }
        }

        const cleanup = () => {
          this.pending.delete(requestId)
          clearTimeout(timer)
          removeAbortListener()
        }

        const timer = setTimeout(() => {
          cleanup()
          log.warn("relay:ask:timeout", {
            requestId: requestId.slice(0, 8),
            toSessionId,
            timeoutMs,
          })
          reject(new AskTimeoutError(toSessionId, timeoutMs))
        }, timeoutMs)

        this.pending.set(requestId, {
          resolve: (msg) => {
            cleanup()
            if (msg.type === "reply") {
              log.info("relay:ask:reply-received", {
                requestId: requestId.slice(0, 8),
                hasReply: !!msg.reply,
                hasError: !!msg.error,
                replyLen: msg.reply?.length ?? 0,
              })
              resolve({ reply: msg.reply, error: msg.error })
            } else if (msg.type === "error") {
              log.error("relay:ask:reply-error", {
                requestId: requestId.slice(0, 8),
                message: msg.message,
              })
              reject(new Error(msg.message))
            } else {
              reject(new Error(`Unexpected response: ${msg.type}`))
            }
          },
          reject: (err) => {
            cleanup()
            log.error("relay:ask:rejected", {
              requestId: requestId.slice(0, 8),
              error: err.message,
            })
            reject(err)
          },
        })

        if (abort) {
          if (abort.aborted) {
            cleanup()
            log.warn("relay:ask:pre-aborted", {
              requestId: requestId.slice(0, 8),
            })
            reject(new Error("Aborted"))
            return
          }
          abortListener = () => {
            cleanup()
            log.warn("relay:ask:aborted", {
              requestId: requestId.slice(0, 8),
            })
            reject(new Error("Aborted"))
          }
          abort.addEventListener("abort", abortListener, { once: true })
        }

        this.post("/api/ask", {
          clientId: this.clientId,
          requestId,
          toSessionId,
          question,
          timeoutMs,
        })
          .then((raw) => {
            const data = raw as { ok: boolean; error?: string }
            if (!data.ok && data.error) {
              cleanup()
              log.error("relay:ask:rejected-by-server", {
                requestId: requestId.slice(0, 8),
                error: data.error,
              })
              reject(new Error(data.error))
            } else {
              log.debug("relay:ask:posted", {
                requestId: requestId.slice(0, 8),
              })
            }
          })
          .catch((err) => {
            cleanup()
            log.error("relay:ask:post-fail", {
              requestId: requestId.slice(0, 8),
              error: err instanceof Error ? err.message : String(err),
            })
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      },
    )
  }

  startInbox(handler: InboxHandler): void {
    this.inboxHandler = handler
    log.info("relay:inbox:start", { url: this.relayUrl })
    this.ensurePollStarted()
  }

  async stopInbox(): Promise<void> {
    this.inboxHandler = null
    log.info("relay:inbox:stop")
  }

  async dispose(): Promise<void> {
    log.info("relay:dispose", {
      pendingCount: this.pending.size,
      registeredCount: this.registeredEntries.size,
    })
    this.disposed = true
    this.stopPoll()

    const err = new Error("Transport disposed")
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()

    this.inboxHandler = null
    this.registeredEntries.clear()
  }

  private checkDisposed(): void {
    if (this.disposed) throw new Error("Transport disposed")
  }

  private ensurePollStarted(): void {
    if (this.pollTimer || this.disposed) return
    log.info("relay:poll:start", {
      url: this.relayUrl,
      intervalMs: RELAY_HTTP_POLL_MS,
    })
    void this.doPoll()
    this.pollTimer = setInterval(
      () => void this.doPoll(),
      RELAY_HTTP_POLL_MS,
    )
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
      log.info("relay:poll:stop")
    }
  }

  private async doPoll(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    try {
      const res = await fetch(
        `${this.relayUrl}/api/poll?clientId=${encodeURIComponent(this.clientId)}`,
        {
          headers: this.authHeaders(),
          // Redirect hardening (W1-U2c item F): a compromised relay must not
          // be able to bounce a client call to a third-party host.
          redirect: "error",
        },
      )
      if (!res.ok) {
        log.warn("relay:poll:http-error", { status: res.status })
        return
      }
      const data = (await res.json()) as { messages?: ServerMessage[] }
      if (data.messages && data.messages.length > 0) {
        log.info("relay:poll:messages", {
          count: data.messages.length,
          types: data.messages.map((m) => m.type),
        })
        for (const msg of data.messages) {
          this.handleMessage(msg)
        }
      }
    } catch (err) {
      log.warn("relay:poll:fail", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.polling = false
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(`${this.relayUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
      // Redirect hardening (W1-U2c item F): a compromised relay must not be
      // able to 302 a client POST (question content in the body) cross-origin.
      redirect: "error",
    })
    if (!res.ok) {
      const text = await res.text()
      log.error("relay:post:http-error", { path, status: res.status, text })
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "reply": {
        const p = this.pending.get(msg.requestId)
        if (p) {
          this.pending.delete(msg.requestId)
          p.resolve(msg)
        } else {
          log.warn("relay:msg:orphan-reply", {
            requestId: msg.requestId.slice(0, 8),
          })
        }
        return
      }
      case "inbound": {
        log.info("relay:msg:inbound", {
          requestId: msg.requestId.slice(0, 8),
          from: msg.fromSessionId,
          to: msg.toSessionId,
          questionLen: msg.question.length,
        })
        void this.handleInbound(msg)
        return
      }
      case "error": {
        log.error("relay:msg:error", {
          requestId: msg.requestId?.slice(0, 8),
          message: msg.message,
        })
        if (msg.requestId !== undefined) {
          const p = this.pending.get(msg.requestId)
          if (p) {
            this.pending.delete(msg.requestId)
            p.reject(new Error(msg.message))
          }
        }
        return
      }
    }
  }

  private async handleInbound(
    msg: Extract<ServerMessage, { type: "inbound" }>,
  ): Promise<void> {
    const handler = this.inboxHandler
    if (!handler) {
      log.warn("relay:inbound:no-handler", {
        requestId: msg.requestId.slice(0, 8),
      })
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        error: "No inbox handler registered",
      })
      return
    }
    try {
      log.info("relay:inbound:processing", {
        requestId: msg.requestId.slice(0, 8),
        toSessionId: msg.toSessionId,
      })
      const reply = await handler(msg.toSessionId, msg.question, {
        timeoutMs: msg.timeoutMs,
      })
      log.info("relay:inbound:replied", {
        requestId: msg.requestId.slice(0, 8),
        replyLen: reply.length,
      })
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        reply,
      })
    } catch (err) {
      const errmsg = err instanceof Error ? err.message : String(err)
      log.error("relay:inbound:error", {
        requestId: msg.requestId.slice(0, 8),
        error: errmsg,
      })
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        error: errmsg,
      })
    }
  }

  private async tryPost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.post(path, body)
    } catch {
      /* ignore */
    }
  }
}
