import test from 'node:test'
import assert from 'node:assert/strict'
import { SlidingWindowRateLimiter } from '../lib/host/rate-limit.js'

test('allows requests up to the configured limit in one window', () => {
  const limiter = new SlidingWindowRateLimiter(2, 60_000)
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, true)
  const rejected = limiter.check('a')
  assert.equal(rejected.allowed, false)
  assert.ok(rejected.retryAfterMs !== undefined)
})

test('keeps independent rate windows per caller', () => {
  const limiter = new SlidingWindowRateLimiter(1, 60_000)
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, false)
  assert.equal(limiter.check('b').allowed, true)
})

test('expires a window after the configured duration', () => {
  const limiter = new SlidingWindowRateLimiter(1, 5)
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, false)
  const before = limiter.check('a')
  assert.equal(before.allowed, false)
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.check('a').allowed, true)
      resolve()
    }, 10)
  })
})
