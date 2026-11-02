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
