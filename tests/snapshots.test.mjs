import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { listSessionSnapshots } from '../lib/host/snapshot-store.js'
import { materializeSessionLogExport } from '../lib/host/log-materialize.js'
import { resolveResumePlan } from '../lib/host/resume-plan.js'
import { resolveSourceLog } from '../lib/host/session-log.js'

function attachmentsFor() {
  return {
    async readImage() {
      return { data: new Uint8Array([137, 80, 78, 71]) }
    },
  }
}

function ctxFor({ records, persistence, workspaceRegistry, cacheRoot }) {
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
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'attachments') return attachmentsFor()
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: persistence,
    workspaceRegistry,
    attachments: attachmentsFor(),
    resumeCacheRoot: cacheRoot,
  }
}

function persistenceFor(content = '{"seq":1}\n') {
  return {
    supportsRawArtifacts: true,
    async readRaw() {
      return { meta: { id: 'sess_1' }, filename: 'session.jsonl', content }
    },
  }
}

function workspaceRegistryFor() {
  return {
    list() {
      return [{ id: 'ws_1', path: 'D:/AI/project', sessionIds: ['sess_1'] }]
    },
    async resolveByPath() {
      return undefined
    },
    async create() {
      return undefined
    },
  }
}

test('materializes into a sequence-numbered snapshot directory and returns snapshotId', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' }, live: false, persisted: true }],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })

  const result = await materializeSessionLogExport(
    ctx,
    { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' },
    'sess_1',
  )
  assert.equal(result.snapshotId, '1')
  assert.match(result.path, /snapshots[\\/]1$/)
  assert.equal(await readFile(result.rootPath, 'utf8'), '{"seq":1}\n')
  assert.equal(await readFile(join(result.path, 'session.jsonl'), 'utf8'), '{"seq":1}\n')

  await rm(cacheRoot, { recursive: true, force: true })
})

test('keeps retention newest snapshots and prunes older ones', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  const raw = { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }

  // Create 5 snapshots with retention 3
  for (let i = 0; i < 5; i += 1) {
    await materializeSessionLogExport(ctx, raw, 'sess_1', { retention: 3 })
  }

  const snapshots = await listSessionSnapshots(ctx, 'sess_1')
  assert.deepEqual(snapshots.map((s) => s.snapshotId), ['3', '4', '5'])

  await rm(cacheRoot, { recursive: true, force: true })
})

test('listSessionSnapshots returns empty for unknown sessions', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const ctx = ctxFor({
    records: [],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  assert.deepEqual(await listSessionSnapshots(ctx, 'missing'), [])
  await rm(cacheRoot, { recursive: true, force: true })
})

test('concurrent materializations of the same source share one task', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  let traceCalls = 0
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  ctx.sessionQuery = {
    ...ctx.sessionQuery,
    traceSession: async () => {
      traceCalls += 1
      return { descendants: [] }
    },
  }

  const raw = { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
  const [first, second] = await Promise.all([
    materializeSessionLogExport(ctx, raw, 'sess_1'),
    materializeSessionLogExport(ctx, raw, 'sess_1'),
  ])
  assert.equal(first.path, second.path)
  // The shared task materializes the log exactly once.
  assert.equal(traceCalls, 1)
  assert.equal(await readFile(first.rootPath, 'utf8'), '{"seq":1}\n')
  await rm(cacheRoot, { recursive: true, force: true })
})

test('resolveResumePlan with a snapshotId reuses the existing snapshot without re-materializing', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  let readRawCalls = 0
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project', title: '历史' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        readRawCalls += 1
        return { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
      },
    },
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  const raw = { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
  await materializeSessionLogExport(ctx, raw, 'sess_1')

  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_hist', '1')
  assert.equal(plan.ok, true)
  assert.equal(plan.sources[0].snapshotId, '1')
  assert.match(plan.sources[0].path, /snapshots[\\/]1$/)
  assert.equal(readRawCalls, 0)

  await rm(cacheRoot, { recursive: true, force: true })
})

test('resolveResumePlan with an unknown snapshotId fails closed', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  const plan = await resolveResumePlan(ctx, 'sess_1', 'attempt_hist', 'nope')
  assert.equal(plan.ok, false)
  assert.equal(plan.status, 404)
  await rm(cacheRoot, { recursive: true, force: true })
})

test('snapshot listing tolerates a legacy non-snapshot layout in the session root', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const sessRoot = join(cacheRoot, 'sess_1')
  const snapDir = join(sessRoot, 'snapshots', '3000')
  await mkdir(snapDir, { recursive: true })
  await writeFile(join(snapDir, 'session.jsonl'), '{"seq":1}\n', 'utf8')

  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: persistenceFor(),
    workspaceRegistry: workspaceRegistryFor(),
    cacheRoot,
  })
  const snapshots = await listSessionSnapshots(ctx, 'sess_1')
  assert.deepEqual(snapshots.map((s) => s.snapshotId), ['3000'])
  await rm(cacheRoot, { recursive: true, force: true })
})

test('listed snapshots count descendant logs stored under subagent directories', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const snapDir = join(cacheRoot, 'sess_1', 'snapshots', '1')
  await mkdir(join(snapDir, 'subagents', 'child'), { recursive: true })
  await writeFile(join(snapDir, 'session.jsonl'), '{"seq":1}\n', 'utf8')
  await writeFile(join(snapDir, 'subagents', 'child', 'session.jsonl'), '{"child":1}\n', 'utf8')

  const snapshots = await listSessionSnapshots({ resumeCacheRoot: cacheRoot }, 'sess_1')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].readable, true)
  assert.equal(snapshots[0].layout.descendants, 1)

  await rm(cacheRoot, { recursive: true, force: true })
})

test('non-directory snapshots are skipped and unreadable snapshots fail closed', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const sessRoot = join(cacheRoot, 'sess_1')
  await mkdir(join(sessRoot, 'snapshots'), { recursive: true })
  await writeFile(join(sessRoot, 'snapshots', '1'), 'not a directory', 'utf8')
  await mkdir(join(sessRoot, 'snapshots', '2'), { recursive: true })

  const ctx = { resumeCacheRoot: cacheRoot }
  const snapshots = await listSessionSnapshots(ctx, 'sess_1')
  assert.deepEqual(snapshots.map((s) => s.snapshotId), ['2'])
  assert.equal(snapshots[0].readable, false)

  const nonDirectory = await resolveSourceLog(ctx, 'sess_1', '1')
  assert.equal(nonDirectory.ok, false)
  assert.equal(nonDirectory.status, 404)
  const unreadable = await resolveSourceLog(ctx, 'sess_1', '2')
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.status, 404)

  await rm(cacheRoot, { recursive: true, force: true })
})

test('zero-byte root artifacts are not treated as readable snapshots', async () => {
  const cacheRoot = join(tmpdir(), 'dsh-session-resume-snap-tests', randomUUID())
  const snapDir = join(cacheRoot, 'sess_1', 'snapshots', '1')
  await mkdir(snapDir, { recursive: true })
  await writeFile(join(snapDir, 'session.jsonl'), '', 'utf8')

  const ctx = { resumeCacheRoot: cacheRoot }
  const snapshots = await listSessionSnapshots(ctx, 'sess_1')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].readable, false)
  assert.equal(snapshots[0].rootPath, undefined)

  const resolved = await resolveSourceLog(ctx, 'sess_1', '1')
  assert.equal(resolved.ok, false)
  assert.equal(resolved.status, 404)

  await rm(cacheRoot, { recursive: true, force: true })
})
