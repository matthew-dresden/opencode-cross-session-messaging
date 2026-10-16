/**
 * Minimal structural types for the opencode V2 plugin API.
 *
 * The V2 host (`@opencode/plugin`) ships its own full type definitions, but
 * importing them would add a runtime dependency for the server plugin. The
 * canary probe (matthew-dresden/opencode-plugin-canary, story 2.0) proved the
 * plain-object `Plugin.define` output shape passes V2 schema validation, so
 * this package declares the narrow surface it actually uses instead. The
 * shapes mirror `@opencode/plugin` 2.0.30 (`dist/promise/plugin.d.ts`,
 * `dist/promise/tool.d.ts`, `dist/promise/event.d.ts`) and are verified by
 * `src/index.v2.test.ts` against mocked hosts.
 */

/** JSON Schema object describing a V2 tool's input. */
export interface V2ToolInputSchema {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: readonly string[]
  additionalProperties: false
}

/** V2 tool execution context (`Tool.Context` + `signal`). */
export interface V2ToolContext {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** V2 tool result — structured content. */
export interface V2ToolResult {
  readonly content: string
}

/** V2 tool definition as accepted by `ToolEditor.add`. */
export interface V2ToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: V2ToolInputSchema
  readonly execute: (
    input: Record<string, unknown>,
    context: V2ToolContext,
  ) => Promise<V2ToolResult>
}

/** Synchronous editor handed to `ctx.tool.transform`. */
export interface V2ToolEditor {
  add(tool: V2ToolDefinition): void
}

/** One event from the V2 server event stream (`V2EventEncoded`). */
export interface V2Event {
  readonly type: string
  readonly properties?: unknown
  /** V2 event payload. For `session.deleted`: `{ sessionID: string }`. */
  readonly data?: unknown
}

/** V2 event domain — async subscription to the server event stream. */
export interface V2EventDomain {
  subscribe(options?: {
    signal?: AbortSignal
  }): AsyncIterable<V2Event>
}

/** V2 session domain — the subset the ask pipeline drives. */
export interface V2SessionDomain {
  prompt(input: {
    sessionID: string
    text: string
  }): Promise<unknown>
  context(input: {
    sessionID: string
  }): Promise<readonly unknown[]>
}

/** The V2 plugin context surface used by this plugin's setup. */
export interface V2PluginContext {
  readonly app?: { readonly version?: string }
  readonly location: {
    readonly directory: string
    readonly project: {
      readonly id: string
    }
  }
  readonly session: V2SessionDomain
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<unknown>
  }
  readonly event: V2EventDomain
}

/** Cleanup function returned from V2 setup. */
export type V2Cleanup = () => Promise<void> | void
