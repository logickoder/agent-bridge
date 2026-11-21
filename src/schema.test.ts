import { describe, expect, it } from 'vitest'
import { Reply } from './schema.js'

describe('Reply', () => {
  it('accepts a sent reply from a daemon that predates `listening`', () => {
    const r = Reply.parse({ type: 'sent', id: 'x', live: false, queued: 1 })
    expect(r).toEqual({ type: 'sent', id: 'x', live: false, pushed: false, queued: 1, listening: [], via: 'local' })
  })
})

describe('Message.from', () => {
  const base = { id: 'm1', to: 'coder', text: 'hi', ts: 't' }

  it('accepts peer names and remote addresses only', async () => {
    const { Message } = await import('./schema.js')
    expect(Message.safeParse({ ...base, from: 'shell' }).success).toBe(true)
    expect(Message.safeParse({ ...base, from: 'planner@bob' }).success).toBe(true)
    expect(Message.safeParse({ ...base, from: 'x" ; rm -rf ~ ; "' }).success).toBe(false)
  })
})
