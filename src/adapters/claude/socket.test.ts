import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { aliveWith, deliverWith, endpointFromEnv, type Connect } from './socket.js'

const msg: Message = { id: 'm1', from: 'b-agy', to: 'b-claude', text: 'hello\nthere', ts: '2026-11-02T00:00:00.000Z' }

describe('endpointFromEnv', () => {
  it('takes the documented socket path from Claude Code, and never the token', () => {
    expect(endpointFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'secret' }, () => 'f1')).toEqual({
      socket: '/tmp/cc-socks/1.sock',
      file: 'f1',
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

describe('aliveWith', () => {
  it('is true when the socket accepts a connection, and writes nothing', async () => {
    const sock = new PassThrough()
    let written = ''
    sock.on('data', (d: Buffer) => {
      written += d.toString()
    })
    expect(await aliveWith(async () => sock, () => 'f1')({ socket: '/tmp/cc-socks/1.sock', file: 'f1' })).toBe(true)
    expect(written).toBe('')
    expect(sock.destroyed).toBe(true)
  })

  it('is false when the socket is gone or the endpoint is malformed', async () => {
    const gone: Connect = async () => {
      throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
    }
    expect(await aliveWith(gone, () => 'f1')({ socket: '/tmp/cc-socks/1.sock', file: 'f1' })).toBe(false)
    expect(await aliveWith(async () => new PassThrough())({ socket: 'relative.sock' })).toBe(false)
  })
})

describe('a socket path reused by a later session', () => {
  it('is not alive, and delivery refuses it, when the socket file changed', async () => {
    const open: Connect = async () => new PassThrough()
    const later = () => 'f2'
    expect(await aliveWith(open, later)({ socket: '/tmp/cc-socks/1.sock', file: 'f1' })).toBe(false)
    expect(await aliveWith(open, later)({ socket: '/tmp/cc-socks/1.sock' })).toBe(false)
    await expect(deliverWith(open, later)({ socket: '/tmp/cc-socks/1.sock', file: 'f1' }, msg)).rejects.toThrow(/no longer this session's socket/)
  })
})
