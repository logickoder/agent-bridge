import { describe, expect, it } from 'vitest'
import { formatSent } from './format.js'

describe('formatSent', () => {
  it('says live or queued', () => {
    expect(formatSent('agy', { id: 'x', live: true, queued: 1, listening: [] })).toBe('Delivered live to agy (id x).')
    expect(formatSent('agy', { id: 'x', live: false, queued: 2, listening: [] })).toMatch(/^Queued for agy \(id x, 2 waiting\)/)
  })

  it('names who is listening when the recipient is not', () => {
    const out = formatSent('b-agy', { id: 'x', live: false, queued: 1, listening: ['b-agy-2'] })
    expect(out).toMatch(/Listening now: b-agy-2\. If b-agy has ended, resend to one of them\./)
  })
})
