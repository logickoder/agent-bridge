import { describe, expect, it } from 'vitest'
import { Reply } from './schema.js'

describe('Reply', () => {
  it('accepts a sent reply from a daemon that predates `listening`', () => {
    const r = Reply.parse({ type: 'sent', id: 'x', live: false, queued: 1 })
    expect(r).toEqual({ type: 'sent', id: 'x', live: false, queued: 1, listening: [] })
  })
})
