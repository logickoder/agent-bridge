/** A token bucket. `take` spends one token if there is one. Time is passed in, so tests need no clock. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = capacity
    this.last = now
  }

  take(now: number): boolean {
    this.refill(now)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  /** Milliseconds until one token is available. 0 if one is available now. */
  waitMs(now: number): number {
    this.refill(now)
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.perSecond) * 1000)
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSecond)
    this.last = now
  }
}
