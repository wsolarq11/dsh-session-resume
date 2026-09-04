/**
 * Empirical decision test: is the WAL necessary for the resume order's
 * correctness, or only for cross-restart recovery?
 *
 * Ground truth target (question "需要 WAL 吗？不可缺失性是？"):
 *  - The resume order book's CORRECTNESS (attemptId dedup, same-source
 *    serialization, idempotent /complete, failed-plan caching) is pure
 *    in-memory and does NOT need the WAL.
 *  - The ONLY thing the WAL adds is `loadFromWal()`: recovering terminal
 *    attempt states after a Host restart so a later /complete stays
 *    idempotent instead of returning 404.
 * These assertions pin that boundary so a future refactor cannot silently
 * move WAL from "optional recovery layer" to "required for correctness".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ResumeOrderBook } from '../lib/host/resume-order.js'

const okPlan = (attemptId) => ({
  ok: true,
  attemptId,
  source: { sessionId: 'sess_1' },
  target: { workspaceId: 'ws_1' },
})

// Explicitly construct WITHOUT a WAL: this is the "what if WAL removed" probe.
// Every correctness property below must hold in pure memory.
function bookWithoutWal() {
  return new ResumeOrderBook({ wal: undefined })
}

test('EMPIRICAL no-WAL: same attemptId resolves once and shares the plan', async () => {
  const book = bookWithoutWal()
  let calls = 0
  const task = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return okPlan('a1')
  }
  const [a, b] = await Promise.all([
    book.run('sess_1', 'a1', task),
    book.run('sess_1', 'a1', task),
  ])
  assert.equal(calls, 1, 'plan task must run exactly once without WAL')
  assert.equal(a, b)
})

test('EMP-2 no-WAL: complete is idempotent and keeps first terminal', async () => {
  const book = bookWithoutWal()
  await book.run('sess_1', 'ok_a', async () => okPlan('ok_a'))
  const first = await book.complete('ok_a', 'tgt_1', 'accepted')
  const second = await book.complete('ok_a', 'tgt_2', 'accepted')
  const conflict = await book.complete('ok_a', 'tgt_3', 'failed')
  assert.equal(first.status, 'accepted')
  assert.equal(second.status, 'accepted')
  assert.equal(second.targetSessionId, 'tgt_1', 'no-WAL must keep first terminal state')
  assert.equal(conflict.status, 'accepted')
})

test('EMP-3 no-WAL: concurrent same-attempt plans serialize on one source', async () => {
  const book = bookWithoutWal()
  let maxActive = 0
  let active = 0
  const task = (id) => async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return okPlan(id)
  }
  await Promise.all([
    book.run('sess_1', 'x1', task('x1')),
    book.run('sess_1', 'x2', task('x2')),
  ])
  assert.equal(maxActive, 1, 'same-source attempts must serialize even without WAL')
})

test('EMP-4 no-WAL: failed plans are cached so retries do not repeat the task', async () => {
  const book = bookWithoutWal()
  let calls = 0
  const task = async () => {
    calls += 1
    return { ok: false, status: 404, error: 'missing' }
  }
  const first = await book.run('sess_1', 'f1', task)
  const second = await book.run('sess_1', 'f1', task)
  assert.equal(calls, 1)
  assert.equal(first.error, second.error)
})

// The one thing the WAL uniquely provides: cross-restart recovery. Prove the
// boundary by asserting that WITHOUT a WAL, loadFromWal restores nothing and a
// post-"restart" attempt lookup is empty (this is the only regression surface).
test('EMP-5 no-WAL: loadFromWal restores nothing = the only WAL-specific capability', async () => {
  const book = bookWithoutWal()
  await book.run('sess_1', 'term_1', async () => okPlan('term_1'))
  await book.complete('term_1', 't_1', 'accepted')
  // Simulate a Host restart: a fresh book has no memory and, without a WAL,
  // cannot recover the terminal state — a later complete returns null->404.
  const restarted = bookWithoutWal()
  await restarted.loadFromWal()
  assert.equal(restarted.get('term_1'), undefined, 'no-WAL cannot recover across a simulated restart')
})