import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildResumeBatchText,
} from '../lib/shared/batch-text.js'
import { resolveResumeBatchPlan } from '../lib/host/resume-plan.js'

function ctxFor({ records, workspaceRegistry, cacheRoot }) {
  const query = {
    listSessions: async () => records,
    readTitle: async (sessionId) => {
      const record = records.find((item) => item.header.id === sessionId)
      return record?.header.title ? { title: record.header.title } : undefined
    },
  }
  return {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'sessionPersistence') return {
        supportsRawArtifacts: true,
        async readRaw(id) {
          const record = records.find((item) => item.header.id === id)
          if (!record) return undefined
          return { meta: { id }, filename: 'session.jsonl', content: `{"seq":1}\n` }
        },
      }
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'attachments') return { async readImage() { return { data: new Uint8Array([1]) } } }
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: {
      supportsRawArtifacts: true,
      async readRaw(id) {
        const record = records.find((item) => item.header.id === id)
        if (!record) return undefined
        return { meta: { id }, filename: 'session.jsonl', content: `{"seq":1}\n` }
      },
    },
    workspaceRegistry,
    attachments: { async readImage() { return { data: new Uint8Array([1]) } } },
    resumeCacheRoot: cacheRoot,
  }
}

function workspaceRegistryFor(membership) {
  return {
    list() {
      return [{ id: 'ws_1', path: 'D:/AI/project', sessionIds: [...membership] }]
    },
    async resolveByPath(path) {
      return path === 'D:/AI/project'
        ? { id: 'ws_1', path, sessionIds: [] }
        : undefined
    },
    async create(path) {
      return { id: 'ws_created', path, sessionIds: [] }
    },
  }
}

test('buildResumeBatchText lists all snapshot paths with labels and instruction', () => {
  const text = buildResumeBatchText(
    [
      { path: 'D:/s1/session.jsonl', label: '任务 A', snapshotId: '1000' },
      { path: 'D:/s2/session.jsonl', label: '任务 B' },
    ],
    '请继续',
  )
  assert.match(text, /2 个会话快照/)
  assert.match(text, /D:\/s1\/session\.jsonl/)
  assert.match(text, /【任务 A】/)
  assert.match(text, /快照 1000/)
  assert.match(text, /请继续/)
  assert.doesNotMatch(text, /workspace-state/)
})

test('buildResumeBatchText appends the workspace-state pointer when any source packaged it', () => {
  const text = buildResumeBatchText(
    [
      { path: 'D:/s1/session.jsonl', label: 'A' },
      { path: 'D:/s2/session.jsonl', label: 'B', workspaceState: true },
    ],
    '请继续',
  )
  assert.match(text, /workspace-state/)
  assert.match(text, /文件清单与 git 状态/)
})

test('resolveResumeBatchPlan materializes multiple sources and resolves target workspace', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-batch-tests', randomUUID())
  const records = [
    { header: { id: 'sess_a', cwd: 'D:/AI/project', title: 'A' }, live: false, persisted: true },
    { header: { id: 'sess_b', cwd: 'D:/AI/project', title: 'B' }, live: false, persisted: true },
  ]
  const ctx = ctxFor({
    records,
    workspaceRegistry: workspaceRegistryFor(['sess_a', 'sess_b']),
    cacheRoot,
  })

  const plan = await resolveResumeBatchPlan(ctx, ['sess_a', 'sess_b'], 'attempt_batch')
  assert.equal(plan.ok, true)
  assert.equal(plan.attemptId, 'attempt_batch')
  assert.equal(plan.sources.length, 2)
  assert.deepEqual(plan.sources.map((s) => s.sessionId), ['sess_a', 'sess_b'])
  assert.equal(plan.target.workspaceId, 'ws_1')
  assert.ok(plan.target.cwd)
  await rm(cacheRoot, { recursive: true, force: true })
})

test('resolveResumeBatchPlan rejects empty or oversized session lists', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-batch-tests', randomUUID())
  const ctx = ctxFor({
    records: [],
    workspaceRegistry: workspaceRegistryFor([]),
    cacheRoot,
  })
  const empty = await resolveResumeBatchPlan(ctx, [], 'attempt_empty')
  assert.equal(empty.ok, false)
  assert.equal(empty.status, 400)
  for (const count of [4, 5, 6]) {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1))
    const big = await resolveResumeBatchPlan(ctx, ids, 'attempt_big')
    assert.equal(big.ok, false)
    assert.equal(big.status, 400)
  }
  await rm(cacheRoot, { recursive: true, force: true })
})

test('resolveResumeBatchPlan fails when a source session is missing', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-batch-tests', randomUUID())
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_a', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    workspaceRegistry: workspaceRegistryFor(['sess_a']),
    cacheRoot,
  })
  const plan = await resolveResumeBatchPlan(ctx, ['sess_a', 'missing'], 'attempt_batch')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 404)
  assert.match(plan.error, /不存在或不可读/)
  await rm(cacheRoot, { recursive: true, force: true })
})
