import { describe, expect, it } from 'vitest'
import { monitorLine, monitorNotice } from './format.js'

describe('monitorLine', () => {
  it('keeps a multi-line message on one line and says how to reply', () => {
    const line = monitorLine({ id: 'm1', from: 'b-agy', to: 'b-claude', text: 'line one\nline two', ts: '2026-11-02T00:00:00.000Z' })
    expect(line).not.toContain('\n')
    expect(line).toContain('"line one\\nline two"')
    expect(line).toContain('agent-bridge send --as b-claude b-agy')
  })
})

describe('monitorNotice', () => {
  it('flattens a notice to one line', () => {
    expect(monitorNotice('a\n  b')).toBe('[agent-bridge] a b')
  })
})

describe('messages from another user\'s agent', () => {
  it('keeps the monitor line on one line and adds the caution', () => {
    const line = monitorLine({ id: 'm1', from: 'planner@bob', to: 'coder', text: 'a\nb', ts: 't', verified: false, origin: { network: 'team', member: 'bob', keyVerified: true, allow: 'ask' } })
    expect(line).not.toContain('\n')
    expect(line).toContain('agent-bridge send --as coder planner@bob "<reply>"')
    expect(line).toMatch(/untrusted input/)
  })
})
