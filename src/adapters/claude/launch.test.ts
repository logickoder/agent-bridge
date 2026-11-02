import { describe, expect, it } from 'vitest'
import { claudeArgs, parseLaunchArgs } from './launch.js'

describe('parseLaunchArgs', () => {
  it('defaults to "claude" and passes everything through', () => {
    expect(parseLaunchArgs(['--model', 'opus'])).toEqual({ name: 'claude', passthrough: ['--model', 'opus'] })
  })

  it('takes a leading --as', () => {
    expect(parseLaunchArgs(['--as', 'lead', '-c'])).toEqual({ name: 'lead', passthrough: ['-c'] })
  })

  it('rejects a bad name', () => {
    expect(() => parseLaunchArgs(['--as', 'Bad Name'])).toThrow(/--as "Bad Name" is invalid/)
  })
})

describe('claudeArgs', () => {
  it('loads only this server, with the dev channel flag and the peer name in env', () => {
    const args = claudeArgs('lead', ['-c'], { AGENT_BRIDGE_HOME: '/tmp/ab' })
    expect(args.slice(2)).toEqual(['--dangerously-load-development-channels', 'server:agent-bridge', '-c'])
    expect(args[0]).toBe('--mcp-config')
    const config: unknown = JSON.parse(args[1] ?? '')
    expect(config).toMatchObject({
      mcpServers: { 'agent-bridge': { args: [expect.stringMatching(/cli\.js$/), 'mcp', 'claude'], env: { AGENT_BRIDGE_PEER: 'lead', AGENT_BRIDGE_HOME: '/tmp/ab' } } },
    })
  })
})
