import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_REFERENCES, rewriteText } from '../lib/index.js'
import { resolveFromText } from '../lib/io/fs/session-log.js'

function sessionQuery(records) {
  return {
    listSessions: async () => records,
    readTitle: async (sessionId) => {
      const record = records.find((item) => item.header.id === sessionId)
      return record?.header.title ? { title: record.header.title } : undefined
    },
  }
}

function ctxFor(records) {
  const query = sessionQuery(records)
  return {
    get(name) {
      return name === 'sessionQuery' ? query : undefined
    },
    sessionQuery: query,
  }
}

test('rewrites a pasted log URL into a canonical mention', async () => {
  const ctx = ctxFor([{ header: { id: 'sess_1', title: '任务 A' } }])
  const text = '请继续 /api/session.export?sessionId=sess_1&includeDescendants=true'
  const rewritten = await rewriteText(ctx, text, 'agent-b')
  assert.match(rewritten, /@\[任务 A\]\(dsh-session:InNlc3NfMSI\)/)
  assert.doesNotMatch(rewritten, /api\/session\.export/)
})

test('skips the target agent session and unresolved ids', async () => {
  const ctx = ctxFor([{ header: { id: 'sess_1', title: '任务 A' } }])
  const text = '/api/session.export?sessionId=sess_1 /api/session.export?sessionId=missing'
  const rewritten = await rewriteText(ctx, text, 'sess_1')
  assert.equal(rewritten, text)
})

test('leaves the whole message unchanged when any reference cannot be resolved', async () => {
  // Here the unresolved `missing` reference is NOT the target agent, so a naive
  // partial rewrite would have produced a mention + raw-URL mix. It must not.
  const ctx = ctxFor([{ header: { id: 'sess_1', title: '任务 A' } }])
  const text = '/api/session.export?sessionId=sess_1 /api/session.export?sessionId=missing'
  const rewritten = await rewriteText(ctx, text, 'agent-b')
  assert.equal(rewritten, text)
})

test('rewrites exactly three distinct references without leaving a fourth raw URL', async () => {
  const records = [1, 2, 3].map((n) => ({ header: { id: `sess_${n}`, title: `任务 ${n}` } }))
  const ctx = ctxFor(records)
  const text = [1, 2, 3]
    .map((n) => `/api/session.export?sessionId=sess_${n}&includeDescendants=true`)
    .join(' ')
  const rewritten = await rewriteText(ctx, text, 'agent-b')
  assert.equal((rewritten.match(/dsh-session:/g) ?? []).length, 3)
  assert.doesNotMatch(rewritten, /api\/session\.export/)
})

test('leaves all legacy URLs unchanged when the reference cap is exceeded', async () => {
  const records = [1, 2, 3, 4].map((n) => ({ header: { id: `sess_${n}`, title: `任务 ${n}` } }))
  const ctx = ctxFor(records)
  const text = [1, 2, 3, 4]
    .map((n) => `/api/session.export?sessionId=sess_${n}&includeDescendants=true`)
    .join(' ')
  const rewritten = await rewriteText(ctx, text, 'agent-b')
  assert.equal(MAX_REFERENCES, 3)
  assert.equal(rewritten, text)
  assert.doesNotMatch(rewritten, /dsh-session:/)
})

test('resolves a bare canonical mention through sessionQuery', async () => {
  const ctx = ctxFor([{ header: { id: 'sess_1', title: '任务 A' } }])
  const info = await resolveFromText(ctx, '继续 @[任务 A](dsh-session:InNlc3NfMSI)')
  assert.equal(info?.sessionId, 'sess_1')
  assert.equal(info?.label, '任务 A')
})

test('reads titles from the official settled readTitleSnapshots shape', async () => {
  const query = {
    listSessions: async () => [{ header: { id: 'sess_1' } }],
    readTitleSnapshots: async () => [
      {
        sessionId: 'sess_1',
        status: 'fulfilled',
        value: {
          session: { header: { id: 'sess_1' } },
          title: { title: '官方标题', updatedAt: 1, seq: 2, source: { kind: 'user' } },
        },
      },
    ],
  }
  const ctx = { get: () => query, sessionQuery: query }
  const info = await resolveFromText(ctx, '/api/session.export?sessionId=sess_1')
  assert.equal(info?.sessionId, 'sess_1')
  assert.equal(info?.label, '官方标题')
})

test('also accepts a flat title string from settled readTitleSnapshots', async () => {
  const query = {
    listSessions: async () => [{ header: { id: 'sess_1' } }],
    readTitleSnapshots: async () => [
      { sessionId: 'sess_1', status: 'fulfilled', value: { title: '旧版标题' } },
    ],
  }
  const ctx = { get: () => query, sessionQuery: query }
  const info = await resolveFromText(ctx, '/api/session.export?sessionId=sess_1')
  assert.equal(info?.label, '旧版标题')
})
