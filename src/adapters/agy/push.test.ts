import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { aliveWith, deliverWith, endpointFromEnv, parseAddress, type Run } from './push.js'

const env = {
  ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
  ANTIGRAVITY_CSRF_TOKEN: 'tok',
  ANTIGRAVITY_CONVERSATION_ID: 'conv-1',
  PATH: '/nowhere',
}
const msg: Message = { id: 'm1', from: 'b-claude', to: 'b-agy', text: 'hello', ts: '2026-11-02T00:00:00.000Z' }

describe('endpointFromEnv', () => {
  it('needs the address, token and conversation from run_command', () => {
    expect(endpointFromEnv(env, () => '/bin/agy')).toEqual({ address: '127.0.0.1:1', token: 'tok', conversation: 'conv-1', agy: '/bin/agy' })
    expect(endpointFromEnv({ ...env, ANTIGRAVITY_CSRF_TOKEN: undefined }, () => '/bin/agy')).toBeUndefined()
    expect(endpointFromEnv(env, () => undefined)).toBeUndefined()
  })
})

describe('deliverWith', () => {
  const endpoint = { address: '127.0.0.1:1', token: 'tok', conversation: 'conv-1', agy: '/bin/agy' }

  it('runs agentapi send-message with the endpoint in the environment only', async () => {
    const seen: { exe: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const run: Run = async (exe, args, runEnv) => {
      seen.push({ exe, args, env: runEnv })
      return { code: 0, stdout: '{"response":{"sendMessage":{"recipientId":"conv-1"}}}' }
    }
    await deliverWith(run)(endpoint, msg)
    expect(seen[0]?.exe).toBe('/bin/agy')
    expect(seen[0]?.args.slice(0, 3)).toEqual(['agentapi', 'send-message', 'conv-1'])
    expect(seen[0]?.args[3]).toContain('hello')
    expect(seen[0]?.args.join(' ')).not.toContain('tok')
    expect(seen[0]?.env).toMatchObject({ ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1', ANTIGRAVITY_CSRF_TOKEN: 'tok' })
  })

  it('fails when agentapi reports an error, even with exit 0', async () => {
    const run: Run = async () => ({ code: 0, stdout: '{"response":{},"error":"rpc error: connection refused"}' })
    await expect(deliverWith(run)(endpoint, msg)).rejects.toThrow(/connection refused/)
  })

  it('fails on a non-zero exit', async () => {
    const run: Run = async () => ({ code: 1, stdout: '' })
    await expect(deliverWith(run)(endpoint, msg)).rejects.toThrow(/exit 1/)
  })

  it('refuses to run anything but an executable named agy', async () => {
    const run: Run = async () => ({ code: 0, stdout: '{}' })
    await expect(deliverWith(run)({ ...endpoint, agy: '/tmp/evil' }, msg)).rejects.toThrow(/only runs agy/)
    await expect(deliverWith(run)({ ...endpoint, agy: 'agy' }, msg)).rejects.toThrow(/absolute path/)
  })
})

describe('parseAddress and aliveWith', () => {
  it('parses host:port and IPv6 addresses and rejects invalid ones', () => {
    expect(parseAddress('localhost:59106')).toEqual({ host: 'localhost', port: 59106 })
    expect(parseAddress('[::1]:8080')).toEqual({ host: '::1', port: 8080 })
    expect(parseAddress('localhost:0')).toBeUndefined()
    expect(parseAddress('not-an-address')).toBeUndefined()
  })

  it('probes the parsed host and port', async () => {
    const seen: [string, number][] = []
    const alive = aliveWith(async (host, port) => {
      seen.push([host, port])
      return port === 59106
    })
    expect(await alive({ address: 'localhost:59106' })).toBe(true)
    expect(await alive({ address: 'localhost:9999' })).toBe(false)
    expect(await alive({})).toBe(false)
    expect(seen).toEqual([
      ['localhost', 59106],
      ['localhost', 9999],
    ])
  })
})
