import { describe, expect, it } from 'vitest'
import type { NetMemberInfo } from '../schema.js'
import { formatAgentLevels, formatStatus } from './format.js'

const member = (over: Partial<NetMemberInfo>): NetMemberInfo => ({
  handle: 'bob',
  fingerprint: 'AAAA-BBBB',
  verified: false,
  changed: false,
  online: true,
  host: false,
  self: false,
  allow: 'ask',
  ...over,
})

describe('formatStatus', () => {
  it('shows each member\'s level, and when a raised one lapses', () => {
    const text = formatStatus({ role: 'member', network: 'team', handle: 'alice', url: 'https://x.example', members: [member({ verified: true, allow: 'chat', allowUntil: '2026-11-19T18:00:00.000Z' })] })
    expect(text).toMatch(/bob +online +verified +allow: chat until 2026-11-19T18:00:00.000Z/)
    const scoped = formatStatus({ role: 'member', network: 'team', handle: 'alice', url: 'https://x.example', members: [member({ verified: true, allow: 'work', allowAgents: ['planner'] })] })
    expect(scoped).toMatch(/bob +online +verified +allow: work \(planner only\)/)
  })

  it('says how to start when there is no network', () => {
    expect(formatStatus({ role: 'none', members: [] })).toMatch(/Not in a network\. Host one/)
  })

  it('shows the host its port, members with key state, and the address update line', () => {
    const text = formatStatus({
      role: 'host',
      network: 'team',
      handle: 'alice',
      url: 'https://x.example',
      port: 7787,
      fingerprint: 'CCCC-DDDD',
      members: [member({ handle: 'alice', self: true, host: true }), member({}), member({ handle: 'carol', verified: true, online: false })],
      urlUpdate: 'agent-bridge-url:1:abc.def',
    })
    expect(text).toMatch(/hosted here as alice\. Address: https:\/\/x\.example\. Local port: 7787/)
    expect(text).toContain('  alice (you, host)')
    expect(text).toMatch(/bob +online +unverified +allow: ask +AAAA-BBBB/)
    expect(text).toMatch(/carol +offline +verified/)
    expect(text).toMatch(/Compare fingerprints/)
    expect(text).toContain('agent-bridge net set-url agent-bridge-url:1:abc.def')
  })

  it('flags a changed key and drops the verify hint once everyone is verified', () => {
    const text = formatStatus({
      role: 'member',
      network: 'team',
      handle: 'bob',
      url: 'https://x.example',
      connected: true,
      members: [member({ handle: 'alice', host: true, verified: true }), member({ handle: 'carol', changed: true })],
    })
    expect(text).toMatch(/carol +KEY CHANGED/)
    expect(formatStatus({ role: 'member', network: 'team', handle: 'bob', members: [member({ handle: 'alice', verified: true })] })).not.toMatch(/Compare/)
  })

  it('tells a removed member how to clear it', () => {
    expect(formatStatus({ role: 'member', network: 'team', state: 'revoked', members: [] })).toMatch(/removed this daemon.*net leave/)
  })
})

describe('formatAgentLevels', () => {
  it('names the members raised for this agent', () => {
    const members = [member({ allow: 'work', allowAgents: ['planner'] }), member({ handle: 'dan', allow: 'chat', allowUntil: '2026-11-20T18:00:00.000Z' })]
    expect(formatAgentLevels(members, 'planner')).toBe('Levels for planner: bob: work, dan: chat until 2026-11-20T18:00:00.000Z. Every other member is at ask.')
    expect(formatAgentLevels(members, 'coder')).toBe('Levels for coder: dan: chat until 2026-11-20T18:00:00.000Z. Every other member is at ask.')
  })
  it('says every member asks when none is raised', () => {
    expect(formatAgentLevels([member({})], 'coder')).toBe('Every member is at level ask here: their requests need your user.')
  })
  it('says nothing with no other members', () => expect(formatAgentLevels([member({ self: true })], 'coder')).toBe(''))
})
