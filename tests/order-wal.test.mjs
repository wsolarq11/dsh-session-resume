import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResumeOrderBook } from '../lib/pure/order/resume-order.js'
import { FileResumeOrderWal, resolveOrderWalPath } from '../lib/pure/order/order-wal.js'

const okPlan = (attemptId) => ({
  ok: true,
  attemptId,
  sources: [{ sessionId: 'sess_1', label: 'A', path: 'D:/snap', kind: 'jsonl-directory' }],
  target: { workspaceId: 'ws_1' },
})

test('FileResumeOrderWal appends and loads states', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-wal-tests', randomUUID())
  const wal = new FileResumeOrderWal(root)
  await wal.append({ attemptId: 'a', sourceSessionId: 'sess_1', status: 'planned' })
  await wal.append({ attemptId: 'a', sourceSessionId: 'sess_1', status: 'accepted', targetSessionId: 'new_1' })

  const loaded = await wal.load()
  assert.equal(loaded.size, 1)
  const state = loaded.get('a')
  assert.equal(state.status, 'accepted')
  assert.equal(state.targetSessionId, 'new_1')

  await rm(root, { recursive: true, force: true })
})

test('ResumeOrderBook persists terminal state to the WAL and reloads it', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-wal-tests', randomUUID())
  const wal = new FileResumeOrderWal(root)
  const book = new ResumeOrderBook({ wal })

  await book.run('sess_1', 'attempt_persist', async () => okPlan('attempt_persist'))
  await book.complete('attempt_persist', 'new_1', 'accepted')

  // Simulate a restart: a fresh book backed by the same WAL recovers the terminal state.
  const restarted = new ResumeOrderBook({ wal })
  await restarted.loadFromWal()
  const recovered = restarted.get('attempt_persist')
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.targetSessionId, 'new_1')

  // Complete on the recovered attempt is idempotent and preserves the first terminal state.
  const conflict = await restarted.complete('attempt_persist', 'new_2', 'failed')
  assert.equal(conflict.status, 'accepted')
  assert.equal(conflict.targetSessionId, 'new_1')

  await rm(root, { recursive: true, force: true })
})

test('ResumeOrderBook with WAL still returns the same plan for a repeated attemptId', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-wal-tests', randomUUID())
  const wal = new FileResumeOrderWal(root)
  const book = new ResumeOrderBook({ wal })
  let calls = 0
  const task = async () => {
    calls += 1
    return okPlan('attempt_repeat')
  }
  const [first, second] = await Promise.all([
    book.run('sess_1', 'attempt_repeat', task),
    book.run('sess_1', 'attempt_repeat', task),
  ])
  assert.equal(calls, 1)
  assert.equal(first, second)
  assert.equal(first.ok, true)
  await rm(root, { recursive: true, force: true })
})

test('run waits for WAL recovery before serving new attempts', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const wal = {
    async load() {
      await gate // hold recovery open until the test releases it
      return new Map()
    },
    async append() {},
    async rewrite() {},
  }
  const book = new ResumeOrderBook({ wal })
  const loadPromise = book.loadFromWal() // suspends on the gated wal.load()

  let runSettled = false
  const runPromise = book
    .run('sess_1', 'attempt_after_recovery', async () => okPlan('attempt_after_recovery'))
    .then((plan) => {
      runSettled = true
      return plan
    })
  // A run issued before recovery completes must not settle.
  assert.equal(runSettled, false)

  release() // let recovery finish
  const plan = await runPromise
  assert.equal(plan.ok, true)
  assert.equal(runSettled, true)
  await loadPromise
})

test('WAL append failures are logged instead of silently dropped', async () => {
  const errors = []
  const wal = {
    async load() {
      return new Map()
    },
    async append() {
      throw new Error('disk unavailable')
    },
    async rewrite() {},
  }
  const book = new ResumeOrderBook({
    wal,
    logger: {
      error(...args) {
        errors.push(args.join(' '))
      },
    },
  })
  await book.run('sess_1', 'attempt_wal_fail', async () => okPlan('attempt_wal_fail'))
  assert.ok(errors.some((line) => line.includes('wal-append-failed')))
  assert.ok(errors.some((line) => line.includes('attempt_wal_fail')))
})

test('resolveOrderWalPath points into the cache root', () => {
  const root = join(tmpdir(), 'dsh-session-resume-wal-tests', randomUUID())
  const path = resolveOrderWalPath(root)
  assert.equal(path, join(root, 'orders.jsonl'))
})

test('WAL tolerates corrupt and malformed state lines', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-wal-tests', randomUUID())
  const wal = new FileResumeOrderWal(root)
  await wal.append({ attemptId: 'good', sourceSessionId: 'sess_1', status: 'planned' })
  const raw =
    (await readFile(join(root, 'orders.jsonl'), 'utf8')) +
    'not-json\n' +
    JSON.stringify({ attemptId: 'bad_status', sourceSessionId: 'sess_1', status: 'mystery' }) +
    '\n' +
    JSON.stringify({ attemptId: 'bad_plan', sourceSessionId: 'sess_1', status: 'accepted', plan: { ok: true } }) +
    '\n'
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'orders.jsonl'), raw, 'utf8')
  const loaded = await wal.load()
  assert.equal(loaded.size, 1)
  assert.equal(loaded.get('good').attemptId, 'good')
  await rm(root, { recursive: true, force: true })
})
