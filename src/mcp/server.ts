import { z } from 'zod'
import { toError } from '../lib/errors.js'
import { logger } from '../lib/log.js'
import { onLines, writeLine } from '../lib/wire.js'

/** Name every client sees for this server. Also the key in client configs. */
export const SERVER_NAME = 'agent-bridge'
const VERSION = '0.1.0'
const FALLBACK_PROTOCOL = '2025-06-18'
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INVALID_REQUEST = -32600

const RpcMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})
const InitializeParams = z.object({ protocolVersion: z.string().optional() }).loose()
const CallParams = z.object({ name: z.string(), arguments: z.unknown().optional() })

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: unknown): Promise<string>
}

/** Builds a tool whose arguments are validated by a zod schema. */
export function defineTool<S extends z.ZodType>(spec: {
  name: string
  description: string
  args: S
  run: (args: z.infer<S>) => Promise<string>
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.args),
    async call(raw) {
      const parsed = spec.args.safeParse(raw ?? {})
      if (!parsed.success) throw new Error(`invalid arguments: ${z.prettifyError(parsed.error)}`)
      return spec.run(parsed.data)
    },
  }
}

export interface McpSpec {
  instructions: string
  capabilities?: Record<string, unknown>
  tools: Tool[]
  onInitialized?: () => void
}

export type RpcOut = Record<string, unknown>

/**
 * Minimal MCP server: initialize, ping, tools/list, tools/call. Everything else gets
 * METHOD_NOT_FOUND, which covers agy's `server/discover` probe before initialize.
 */
export function createMcpHandler(spec: McpSpec): (raw: unknown) => Promise<RpcOut | undefined> {
  let initialized = false
  return async raw => {
    const parsed = RpcMessage.safeParse(raw)
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid JSON-RPC message' } }
    const { id, method, params } = parsed.data
    if (id === undefined) {
      if (method === 'notifications/initialized' && !initialized) {
        initialized = true
        spec.onInitialized?.()
      }
      return undefined
    }
    const result = (value: unknown): RpcOut => ({ jsonrpc: '2.0', id, result: value })
    const error = (code: number, message: string): RpcOut => ({ jsonrpc: '2.0', id, error: { code, message } })

    switch (method) {
      case 'initialize': {
        const init = InitializeParams.safeParse(params ?? {})
        return result({
          protocolVersion: (init.success ? init.data.protocolVersion : undefined) ?? FALLBACK_PROTOCOL,
          capabilities: { tools: {}, ...spec.capabilities },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions: spec.instructions,
        })
      }
      case 'ping':
        return result({})
      case 'tools/list':
        return result({ tools: spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const call = CallParams.safeParse(params)
        if (!call.success) return error(INVALID_PARAMS, 'tools/call needs a "name".')
        const tool = spec.tools.find(t => t.name === call.data.name)
        if (!tool) return error(INVALID_PARAMS, `unknown tool "${call.data.name}".`)
        try {
          return result({ content: [{ type: 'text', text: await tool.call(call.data.arguments) }] })
        } catch (err) {
          const text = toError(err).message
          return result({ content: [{ type: 'text', text }], isError: true })
        }
      }
      default:
        return error(METHOD_NOT_FOUND, `method not supported: ${method}`)
    }
  }
}

export interface StdioMcp {
  notify(method: string, params: unknown): void
}

/** Serves the handler over stdin/stdout, newline-delimited. */
export function serveStdio(handle: (raw: unknown) => Promise<RpcOut | undefined>): StdioMcp {
  const log = logger('mcp')
  const send = (obj: unknown): void => writeLine(process.stdout, obj)
  onLines(
    process.stdin,
    raw => {
      handle(raw).then(
        out => out && send(out),
        (err: unknown) => log(`handler failed: ${toError(err).message}`),
      )
    },
    line => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${line.slice(0, 100)}` } }),
  )
  process.stdin.on('end', () => process.exit(0))
  return { notify: (method, params) => send({ jsonrpc: '2.0', method, params }) }
}
