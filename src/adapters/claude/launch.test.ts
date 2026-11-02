import { describe, expect, it } from 'vitest'
import { claudeArgs, parseLaunchArgs } from './launch.js'
import { identityFromEnv } from './mcp.js'

describe('parseLaunchArgs', () => {
  it('has no name by default and passes everything through', () => {
    expect(parseLaunchArgs(['--model', 'opus'])).toEqual({ passthrough: ['--model', 'opus'] })
  })

  it('takes a leading --as', () => {
    expect(parseLaunchArgs(['--as', 'lead', '-c'])).toEqual({ name: 'lead', passthrough: ['-c'] })
  })

  it('rejects a bad name', () => {
    expect(() => parseLaunchArgs(['--as', 'Bad Name'])).toThrow(/--as "Bad Name" is invalid/)
  })
})

const serverEnv = (args: string[]): unknown => {
  const config: unknown = JSON.parse(args[1] ?? '')
  return config
}

describe('claudeArgs', () => {
  it('loads only this server, with the dev channel flag and the explicit name in env', () => {
    const args = claudeArgs({ name: 'lead' }, ['-c'], { AGENT_BRIDGE_HOME: '/tmp/ab' })
    expect(args.slice(2)).toEqual(['--dangerously-load-development-channels', 'server:agent-bridge', '-c'])
    expect(args[0]).toBe('--mcp-config')
    expect(serverEnv(args)).toMatchObject({
      mcpServers: { 'agent-bridge': { args: [expect.stringMatching(/cli\.js$/), 'mcp', 'claude'], env: { AGENT_BRIDGE_PEER: 'lead', AGENT_BRIDGE_HOME: '/tmp/ab' } } },
    })
  })

  it('passes the auto-name base when no name was given', () => {
    const args = claudeArgs({ base: 'bankstract-claude' }, [], {})
    expect(serverEnv(args)).toMatchObject({ mcpServers: { 'agent-bridge': { env: { AGENT_BRIDGE_BASE: 'bankstract-claude' } } } })
  })
})

describe('identityFromEnv', () => {
  it('prefers the explicit name, then the base, else none (send-only)', () => {
    expect(identityFromEnv({ AGENT_BRIDGE_PEER: 'lead', AGENT_BRIDGE_BASE: 'b-claude' })).toEqual({ name: 'lead' })
    expect(identityFromEnv({ AGENT_BRIDGE_BASE: 'b-claude' })).toEqual({ base: 'b-claude' })
    expect(identityFromEnv({})).toBeUndefined()
  })
})
