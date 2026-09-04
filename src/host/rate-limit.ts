/** Small sliding-window limiter for local Host APIs; keeps memory bounded. */

export interface RateLimitDecision {
  allowed: boolean
  retryAfterMs?: number
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string): RateLimitDecision {
    const now = Date.now()
    this.prune(now)
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true }
    }
    if (bucket.count >= this.limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now }
    }
    bucket.count += 1
    return { allowed: true }
  }

  private prune(now: number): void {
    if (this.buckets.size < 1_024) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
    if (this.buckets.size > 1_024) {
      const oldest = [...this.buckets.entries()]
        .sort((left, right) => left[1].resetAt - right[1].resetAt)
        .slice(0, this.buckets.size - 1_024)
      for (const [key] of oldest) this.buckets.delete(key)
    }
  }
}
