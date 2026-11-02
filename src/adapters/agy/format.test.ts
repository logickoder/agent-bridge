import { describe, expect, it } from 'vitest'
import type { Message } from '../../schema.js'
import { formatDrained, formatListened } from './format.js'

const msg = (over: Partial<Message> = {}): Message => ({ id: 'm1', from: 'claude', to: 'agy', text: 'hello', ts: '2026-11-02T00:00:00.000Z', ...over })

describe('formatListened', () => {
  it('shows the message, how to reply, and how to re-arm with the right name', () => {
    const out = formatListened(msg({ to: 'reviewer', verified: true }))
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

describe('reply hints for unverified senders', () => {
  it('does not suggest replying to an unverified sender, and gives push-mode recovery advice', async () => {
    const { formatDrained, formatPushed } = await import('./format.js')
    const shellMsg = msg({ from: 'shell', verified: false })
    expect(formatDrained([shellMsg])).not.toContain('agent-bridge send --as agy shell')
    expect(formatDrained([shellMsg])).toMatch(/not a checked peer/)
    expect(formatDrained([shellMsg])).toContain('agent-bridge join --kind agy')
    expect(formatPushed(msg({ from: 'b-claude', verified: true }))).toContain('agent-bridge send --as agy b-claude')
  })
})
