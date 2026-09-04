import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveResumePlan } from '../lib/host/resume-plan.js'

function queryFor(records) {
  return {
    listSessions: async () => records,
    readTitle: async (sessionId) => {
      const record = records.find((item) => item.header.id === sessionId)
      return record?.header.title ? { title: record.header.title } : undefined
    },
  }
}

function attachmentsFor() {
  return {
    async readImage() {
      return { data: new Uint8Array([137, 80, 78, 71]) }
    },
  }
}

function ctxFor({ records, persistence, workspaceRegistry }) {
  const query = queryFor(records)
  const resumeCacheRoot = join(tmpdir(), 'dsh-session-resume-tests', randomUUID())
  return {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'attachments') return attachmentsFor()
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: persistence,
    workspaceRegistry,
    attachments: attachmentsFor(),
    resumeCacheRoot,
  }
}

async function cleanCache(ctx, sessionId) {
  await rm(join(ctx.resumeCacheRoot, sessionId), { recursive: true, force: true })
}

function persistenceFor() {
  return {
    supportsRawArtifacts: true,
    async readRaw() {
      return { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
    },
  }
}

test('resolves source log and original workspace by session membership', async () => {
  const ctx = ctxFor({
    records: [
      {
        header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' },
        live: false,
        persisted: true,
      },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: {
      list() {
        return [{ id: 'ws_1', path: 'D:/AI/project', sessionIds: ['sess_1'] }]
      },
    },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, true)
  assert.equal(plan.attemptId, 'attempt_1')
  assert.equal(plan.target.workspaceId, 'ws_1')
  assert.equal(plan.target.cwd, 'D:/AI/project')
  assert.equal(plan.sources.length, 1)
  const source = plan.sources[0]
  assert.equal(source.kind, 'jsonl-directory')
  assert.equal(source.rootPath, join(source.path, 'session.jsonl'))
  assert.match(source.mention, /dsh-session:/)
  await cleanCache(ctx, 'sess_1')
})

test('resolves an unowned cwd by registry path before falling back to creation', async () => {
  const ctx = ctxFor({
    records: [
      {
        header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' },
        live: false,
        persisted: true,
      },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: {
      list() {
        return [{ id: 'ws_old', path: 'D:/other', sessionIds: ['sess_2'] }]
      },
      async resolveByPath(path) {
        return path === 'D:/AI/project'
          ? { id: 'ws_by_path', path: 'D:/AI/project', sessionIds: [] }
          : undefined
      },
    },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, true)
  assert.equal(plan.target.workspaceId, 'ws_by_path')
  await cleanCache(ctx, 'sess_1')
})
test('registers an existing unowned cwd as the resume workspace', async () => {
  const attached = []
  const ctx = ctxFor({
    records: [
      {
        header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' },
        live: false,
        persisted: true,
      },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: {
      list() {
        return []
      },
      async resolveByPath() {
        return undefined
      },
      async create(path) {
        return {
          id: 'ws_new',
          path,
          sessionIds: [],
          async attachSession(sessionId) {
            attached.push(sessionId)
          },
        }
      },
    },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, true)
  assert.equal(plan.target.workspaceId, 'ws_new')
  assert.deepEqual(attached, ['sess_1'])
  await cleanCache(ctx, 'sess_1')
})

test('fails closed when source has no cwd and no workspace membership', async () => {
  const ctx = ctxFor({
    records: [
      { header: { id: 'sess_1' }, live: false, persisted: true },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: { list() { return [] } },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 409)
  assert.match(plan.error, /没有工作目录/)
  await cleanCache(ctx, 'sess_1')
})

test('fails closed when the workspace registry is unavailable', async () => {
  const ctx = ctxFor({
    records: [
      { header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: undefined,
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 501)
  assert.match(plan.error, /工作区注册表/)
  await cleanCache(ctx, 'sess_1')
})

test('preserves a 501 source-log failure instead of flattening it to 404', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-tests', randomUUID())
  const records = [
    { header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true },
  ]
  const query = queryFor(records)
  const persistence = persistenceFor()
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: persistence,
    workspaceRegistry: { list: () => [] },
    attachments: undefined,
    resumeCacheRoot: cacheRoot,
  }

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 501)
  assert.match(plan.error, /附件存储/)
  await rm(cacheRoot, { recursive: true, force: true })
})

test('compensates a newly created workspace when source attachment fails', async () => {
  const removed = []
  const ctx = ctxFor({
    records: [
      { header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true },
    ],
    persistence: persistenceFor(),
    workspaceRegistry: {
      list() {
        return []
      },
      async resolveByPath() {
        return undefined
      },
      async create(path) {
        return {
          id: 'ws_new',
          path,
          sessionIds: [],
          async attachSession() {
            throw new Error('attach exploded')
          },
          async remove() {
            removed.push('ws_new')
          },
        }
      },
    },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 500)
  assert.match(plan.error, /已回滚新建工作区/)
  assert.deepEqual(removed, ['ws_new'])
  await cleanCache(ctx, 'sess_1')
})

test('marks a source with legacy message events as legacySurface on the plan', async () => {
  const legacyContent =
    '{"type":"user/message","seq":105993,"data":{"role":"user","source":{"kind":"plugin","plugin":"tool-goal","form":"notice"},"content":[{"type":"text","text":"<goal_complete>"}]}}\n'
  const persistence = {
    supportsRawArtifacts: true,
    async readRaw() {
      return { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: legacyContent }
    },
  }
  const ctx = ctxFor({
    records: [
      {
        header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' },
        live: false,
        persisted: true,
      },
    ],
    persistence,
    workspaceRegistry: {
      list() {
        return [{ id: 'ws_1', path: 'D:/AI/project', sessionIds: ['sess_1'] }]
      },
    },
  })

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_1')
  assert.equal(plan.ok, true)
  assert.equal(plan.sources[0].legacySurface, true)
  await cleanCache(ctx, 'sess_1')
})
