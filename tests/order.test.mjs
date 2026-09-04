import test from 'node:test'
import assert from 'node:assert/strict'
import { ResumeOrderBook } from '../lib/pure/order/resume-order.js'

const okPlan = (attemptId) => ({
  ok: true,
  attemptId,
  source: { sessionId: 'sess_1' },
  target: { workspaceId: 'ws_1' },
})

test('returns the same plan for the same attemptId and runs the task once', async () => {
  const book = new ResumeOrderBook()
  let calls = 0
  const task = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return okPlan('attempt_1')
  }

  const [first, second] = await Promise.all([
    book.run('sess_1', 'attempt_1', task),
    book.run('sess_1', 'attempt_1', task),
  ])

  assert.equal(calls, 1)
  assert.equal(first, second)
  assert.equal(first.ok, true)
})

test('rejects reusing an attemptId for a different source session', async () => {
  const book = new ResumeOrderBook()
  const first = await book.run('sess_1', 'attempt_1', async () => okPlan('attempt_1'))
  const second = await book.run('sess_2', 'attempt_1', async () => okPlan('attempt_1'))
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.status, 409)
  assert.match(second.error, /其他会话/)
})

test('serializes different attempts against the same source session', async () => {
  const book = new ResumeOrderBook()
  const events = []
  let active = 0
  let maxActive = 0
  const task = (attemptId) => async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    events.push(`start:${attemptId}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    events.push(`end:${attemptId}`)
    return okPlan(attemptId)
  }

  await Promise.all([
    book.run('sess_1', 'attempt_a', task('attempt_a')),
    book.run('sess_1', 'attempt_b', task('attempt_b')),
  ])

  assert.equal(maxActive, 1)
  assert.deepEqual(events, ['start:attempt_a', 'end:attempt_a', 'start:attempt_b', 'end:attempt_b'])
})

test('caches failed plans so retries do not repeat the failing task', async () => {
  const book = new ResumeOrderBook()
  let calls = 0
  const task = async () => {
    calls += 1
    return { ok: false, status: 404, error: 'missing' }
  }

  const first = await book.run('sess_1', 'attempt_fail', task)
  const second = await book.run('sess_1', 'attempt_fail', task)
  assert.equal(calls, 1)
  assert.equal(first.error, second.error)
})

test('complete is idempotent and keeps the first terminal state', async () => {
  const book = new ResumeOrderBook()
  await book.run('sess_1', 'attempt_ok', async () => okPlan('attempt_ok'))

  const first = await book.complete('attempt_ok', 'new_1', 'accepted')
  const second = await book.complete('attempt_ok', 'new_2', 'accepted')
  const conflict = await book.complete('attempt_ok', 'new_3', 'failed')

  assert.equal(first.status, 'accepted')
  assert.equal(first.targetSessionId, 'new_1')
  assert.equal(second.status, 'accepted')
  assert.equal(second.targetSessionId, 'new_1')
  assert.equal(conflict.status, 'accepted')
})

test('complete turns a rejected plan into a terminal failed state instead of throwing', async () => {
  const book = new ResumeOrderBook()
  // A throwing resolver is converted to a failed-plan result by run(), so the
  // attempt settles as data and /complete must record the terminal failure
  // instead of surfacing an unhandled rejection.
  const plan = await book.run('sess_1', 'attempt_reject', async () => {
    throw new Error('backend exploded')
  })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /backend exploded/)

  const state = await book.complete('attempt_reject', undefined, 'accepted')
  assert.equal(state.status, 'failed')
  assert.match(state.error, /backend exploded/)
  assert.equal(state.targetSessionId, undefined)
  // A later completion keeps the terminal failure.
  const again = await book.complete('attempt_reject', 'new_9', 'accepted')
  assert.equal(again.status, 'failed')
  assert.match(again.error, /backend exploded/)
})

test('trim drops completed attempts but never a planned in-flight attempt', async () => {
  const book = new ResumeOrderBook({ maxAttempts: 2 })
  await book.run('sess_1', 'attempt_a', async () => okPlan('attempt_a'))
  await book.complete('attempt_a', 'new_a', 'accepted')
  await book.run('sess_1', 'attempt_b', async () => okPlan('attempt_b'))
  await book.complete('attempt_b', 'new_b', 'accepted')
  await book.run('sess_1', 'attempt_c', async () => okPlan('attempt_c'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(book.get('attempt_a'), undefined)
  assert.equal(book.get('attempt_b').status, 'accepted')
  assert.equal(book.get('attempt_c').status, 'planned')
})
