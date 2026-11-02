import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpHandler, defineTool } from './server.js'

const echo = defineTool({
  name: 'echo',
  description: 'Echo text.',
  args: z.object({ text: z.string().min(1) }),
  run: async ({ text }) => {
    if (text === 'boom') throw new Error('it broke')
    return `echo: ${text}`
  },
})

const handler = (onInitialized = vi.fn()) =>
  createMcpHandler({ instructions: 'hi', capabilities: { experimental: { x: {} } }, tools: [echo], onInitialized })

describe('createMcpHandler', () => {
  it('answers server/discover with method-not-found (agy probes it before initialize)', async () => {
    const out = await handler()({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })
    expect(out).toMatchObject({ id: 1, error: { code: -32601 } })
  })

  it('echoes the client protocol version and merges capabilities', async () => {
    const out = await handler()({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    expect(out).toMatchObject({
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, experimental: { x: {} } }, instructions: 'hi' },
    })
  })

  it('fires onInitialized once', async () => {
    const onInit = vi.fn()
    const h = handler(onInit)
    await h({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await h({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(onInit).toHaveBeenCalledTimes(1)
  })

  it('lists tools with a JSON schema', async () => {
    const out = await handler()({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(out).toMatchObject({ result: { tools: [{ name: 'echo', inputSchema: { type: 'object', required: ['text'] } }] } })
  })

  it('calls a tool, and reports bad args and thrown errors as isError', async () => {
    const h = handler()
    const call = (args: unknown) => h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: args } })
    expect(await call({ text: 'hi' })).toMatchObject({ result: { content: [{ text: 'echo: hi' }] } })
    expect(await call({ text: '' })).toMatchObject({ result: { isError: true } })
    expect(await call({ text: 'boom' })).toMatchObject({ result: { isError: true, content: [{ text: 'it broke' }] } })
  })

  it('rejects an unknown tool and a malformed message', async () => {
    const h = handler()
    expect(await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })).toMatchObject({ error: { code: -32602 } })
    expect(await h({ hello: 1 })).toMatchObject({ error: { code: -32600 } })
  })
})
