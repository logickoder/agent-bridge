import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { deliverWith, endpointFromEnv, type Run } from './push.js'

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
})
