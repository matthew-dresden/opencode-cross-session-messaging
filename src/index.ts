import type { PluginModule } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { askAndWaitForReply, type AskClient } from "./askAndWaitForReply.ts"
import { getRelayUrl } from "./config.ts"
import { PLUGIN_ID } from "./constants.ts"
import { createEventHandler, runV2EventSubscription } from "./eventHooks.ts"
import { initLogger, log } from "./logger.ts"
import { createAskSessionTool } from "./tools/askSession.ts"
import { createConnectRelayTool } from "./tools/connectRelay.ts"
import { createListSessionsTool } from "./tools/listSessions.ts"
import { createRegisterSessionTool } from "./tools/registerSession.ts"
import { DelegatingTransport } from "./transport/delegating.ts"
import { FileTransport } from "./transport/file.ts"
import { toV2AskClient } from "./v2ClientAdapter.ts"
import { buildV2Tools } from "./v2Tools.ts"
import type { V2Cleanup, V2PluginContext } from "./v2types.ts"

const CONFIG_POLL_MS = 2_000

/**
 * Dual-shape entrypoint, per reference/plugins-migrate-v1.md
 * ("Support V1 and V2 from one package"): V1 hosts call `server()` and V2
 * hosts call `setup()`. The APIs remain separate; this shape does not
 * translate hooks automatically.
 *
 * The V2 half is a plain object matching the `Plugin.define` output shape
 * (`{ id, setup }`) without importing `@opencode/plugin` — the canary probe
 * (matthew-dresden/opencode-plugin-canary, story 2.0) proved the plain-object
 * shape passes V2 schema validation, so the server plugin ships with zero new
 * runtime dependencies.
 *
 * `server()` preserves the V1 surface byte-compatibly (same tool map, event
 * hook wire shape, and dispose behavior) so V1 hosts keep working through the
 * transition window.
 */

// ---------------------------------------------------------------------------
// Shared daemon wiring. Both shapes build the same transport stack; only the
// client seam (V1 SDK client vs V2 ctx domain adapter) and the registration
// surface (V1 tool map vs V2 transform) differ.
// ---------------------------------------------------------------------------

interface DaemonWiring {
  transport: DelegatingTransport
  daemonId: string
  setLastKnownUrl: (url: string) => void
  dispose: () => Promise<void>
}

async function wireDaemon(params: {
  client: AskClient
  projectId: string
  directory: string
}): Promise<DaemonWiring> {
  const daemonId = randomUUID()
  const relayUrl = getRelayUrl()
  const device = hostname()

  let inner
  if (relayUrl) {
    const { RelayTransport } = await import("./transport/relay.ts")
    inner = new RelayTransport(relayUrl)
    log.info("plugin:init:relay", {
      projectId: params.projectId,
      directory: params.directory,
      daemonId,
      relayUrl,
      device,
    })
  } else {
    inner = new FileTransport(params.client, daemonId)
    log.info("plugin:init:file", {
      projectId: params.projectId,
      directory: params.directory,
      daemonId,
      device,
    })
  }

  const transport = new DelegatingTransport(inner)

  transport.startInbox((sessionId, question, opts) =>
    askAndWaitForReply(params.client, sessionId, question, opts),
  )

  let lastKnownUrl = relayUrl
  const configPoller = setInterval(() => {
    const currentUrl = getRelayUrl()
    if (currentUrl === lastKnownUrl) return
    lastKnownUrl = currentUrl
    if (currentUrl) {
      void import("./transport/relay.ts")
        .then(({ RelayTransport }) =>
          transport.switchTo(new RelayTransport(currentUrl)),
        )
        .then(() => log.info("config:relay-connected", { url: currentUrl }))
        .catch((err) =>
          log.warn("config:relay-connect-fail", {
            url: currentUrl,
            error: String(err),
          }),
        )
    }
  }, CONFIG_POLL_MS)

  return {
    transport,
    daemonId,
    setLastKnownUrl: (url: string) => {
      lastKnownUrl = url
    },
    dispose: async () => {
      clearInterval(configPoller)
      await transport.dispose()
      log.info("plugin:dispose")
    },
  }
}

// ---------------------------------------------------------------------------
// V1 entrypoint — byte-compatible behavior for V1 hosts.
// ---------------------------------------------------------------------------

const v1Plugin: PluginModule = {
  id: PLUGIN_ID,
  server: async (input) => {
    initLogger(input.client)
    const wiring = await wireDaemon({
      client: input.client as unknown as AskClient,
      projectId: input.project.id,
      directory: input.directory,
    })
    return {
      tool: {
        register_session: createRegisterSessionTool(wiring.transport, {
          projectId: input.project.id,
          serverUrl: input.serverUrl.toString(),
          daemonId: wiring.daemonId,
          deviceName: hostname(),
        }),
        list_sessions: createListSessionsTool(wiring.transport, hostname()),
        ask_session: createAskSessionTool(wiring.transport),
        connect_relay: createConnectRelayTool({
          transport: wiring.transport,
          setLastKnownUrl: wiring.setLastKnownUrl,
        }),
      },

      event: createEventHandler(wiring.transport),

      dispose: wiring.dispose,
    }
  },
}

// ---------------------------------------------------------------------------
// V2 entrypoint — plain-object Plugin.define shape.
// ---------------------------------------------------------------------------

const setup = async (ctx: V2PluginContext): Promise<V2Cleanup> => {
  initLogger(null)
  const client = toV2AskClient(ctx.session)
  const wiring = await wireDaemon({
    client,
    projectId: ctx.location.project.id,
    directory: ctx.location.directory,
  })

  const tools = buildV2Tools({
    transport: wiring.transport,
    delegating: wiring.transport,
    projectId: ctx.location.project.id,
    daemonId: wiring.daemonId,
    deviceName: hostname(),
    directory: ctx.location.directory,
    setLastKnownUrl: wiring.setLastKnownUrl,
  })

  // Transforms must stay synchronous and cheap (plugins-migrate-v1, "Migrate
  // custom tools"): the definitions are fully built above; the callback only
  // registers them.
  await ctx.tool.transform((editor) => {
    for (const def of tools) {
      editor.add(def)
    }
  })

  // V2 event subscription (async iterator) with AbortController cleanup —
  // aborted by the cleanup function this setup returns (plugins-migrate-v1,
  // "Migrate events and cleanup").
  const controller = new AbortController()
  void runV2EventSubscription(
    ctx.event.subscribe,
    wiring.transport,
    controller.signal,
  )

  return async () => {
    controller.abort()
    await wiring.dispose()
  }
}

export default {
  ...v1Plugin,
  setup,
}
