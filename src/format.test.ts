import { describe, expect, it } from 'vitest'
import { formatSent } from './format.js'

describe('formatSent', () => {
  it('says live or queued', () => {
    expect(formatSent('agy', { id: 'x', live: true, queued: 1 })).toBe('Delivered live to agy (id x).')
    expect(formatSent('agy', { id: 'x', live: false, queued: 2 })).toMatch(/^Queued for agy \(id x, 2 waiting\)/)
  })
})
