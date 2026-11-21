import { describe, expect, it } from 'vitest'
import { TokenBucket } from './rate.js'

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const b = new TokenBucket(3, 1, 0)
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false])
  })

  it('refills over time, up to capacity only', () => {
    const b = new TokenBucket(2, 10, 0)
    b.take(0)
    b.take(0)
    expect(b.take(50)).toBe(false)
    expect(b.take(100)).toBe(true)
    expect(b.waitMs(100)).toBe(100)
    expect(b.waitMs(10_000)).toBe(0)
    expect([b.take(10_000), b.take(10_000), b.take(10_000)]).toEqual([true, true, false])
  })

  it('ignores a clock that goes backwards', () => {
    const b = new TokenBucket(1, 1, 1000)
    b.take(1000)
    expect(b.take(0)).toBe(false)
  })
})
