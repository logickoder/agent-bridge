import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { deliverWith, endpointFromEnv, type Connect } from './socket.js'

const msg: Message = { id: 'm1', from: 'b-agy', to: 'b-claude', text: 'hello\nthere', ts: '2026-11-02T00:00:00.000Z' }

describe('endpointFromEnv', () => {
  it('takes the documented socket path from Claude Code, and never the token', () => {
    expect(endpointFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'secret' })).toEqual({
      socket: '/tmp/cc-socks/1.sock',
    })
    expect(endpointFromEnv({})).toBeUndefined()
    expect(endpointFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: 'relative.sock' })).toBeUndefined()
  })
})

describe('deliverWith', () => {
  it('writes one peer message line, with no auth line, and resolves once flushed', async () => {
    const sock = new PassThrough()
    let written = ''
    sock.on('data', (d: Buffer) => {
      written += d.toString()
    })
    const connect: Connect = async () => sock
    await deliverWith(connect)({ socket: '/tmp/cc-socks/1.sock' }, msg)
    const lines = written.trim().split('\n')
    expect(lines).toHaveLength(1)
    const line: unknown = JSON.parse(lines[0] ?? '')
    expect(line).toMatchObject({ type: 'user', from: 'agent-bridge:b-agy', message: { role: 'user' } })
    expect(JSON.stringify(line)).toContain('hello\\nthere')
    expect(JSON.stringify(line)).toContain('agent-bridge send --as b-claude b-agy')
  })

  it('fails when the socket cannot be reached', async () => {
    const connect: Connect = async () => {
      throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
    }
    await expect(deliverWith(connect)({ socket: '/tmp/cc-socks/1.sock' }, msg)).rejects.toThrow(/ENOENT/)
  })
})
