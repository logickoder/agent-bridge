import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { formatDrained, formatListened } from './format.js'

const msg = (over: Partial<Message> = {}): Message => ({ id: 'm1', from: 'claude', to: 'agy', text: 'hello', ts: '2026-11-02T00:00:00.000Z', ...over })

describe('formatListened', () => {
  it('shows the message, how to reply, and how to re-arm with the right name', () => {
    const out = formatListened(msg({ to: 'reviewer' }))
    expect(out).toContain('hello')
    expect(out).toContain('agent-bridge send --as reviewer claude')
    expect(out).toContain('`agent-bridge listen --as reviewer`')
  })
})

describe('formatDrained', () => {
  it('lists every message and re-arm commands once per recipient', () => {
    const out = formatDrained([msg(), msg({ id: 'm2', text: 'again' }), msg({ id: 'm3', to: 'agy-b', text: 'b' })])
    expect(out).toContain('hello')
    expect(out).toContain('again')
    expect(out.match(/`agent-bridge listen --as agy`/g)).toHaveLength(1)
    expect(out).toContain('`agent-bridge listen --as agy-b`')
  })
})
