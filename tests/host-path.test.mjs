import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionLogPath } from '../lib/io/fs/session-log.js'
import { safePathSegment } from '../lib/io/fs/snapshot-store.js'

function queryFor(records, trace) {
  return {
    listSessions: async () => records,
    readTitle: async (sessionId) => {
      const record = records.find((item) => item.header.id === sessionId)
      return record?.header.title ? { title: record.header.title } : undefined
    },
    traceSession: trace ? async () => trace : undefined,
  }
}

function attachmentsFor() {
  return {
    async readImage() {
      return { data: new Uint8Array([137, 80, 78, 71]) }
    },
  }
}

function ctxFor({ records, persistence, sessions, trace, attachments }) {
  const query = queryFor(records, trace)
  const resumeCacheRoot = join(tmpdir(), 'dsh-session-resume-tests', randomUUID())
  return {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return sessions
      if (name === 'attachments') return attachments
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: persistence,
    sessions,
    attachments,
    resumeCacheRoot,
  }
}

async function cleanCache(ctx, sessionId) {
  await rm(join(ctx.resumeCacheRoot, sessionId), { recursive: true, force: true })
}

test('materializes the official raw artifact after flushing a live session', async () => {
  const flushed = []
  const sessions = {
    get(id) {
      return id === 'sess_1' ? { id } : undefined
    },
    async flush(session) {
      flushed.push(session.id)
      return true
    },
  }
  const content = '{"seq":1}\n'
  const ctx = ctxFor({
    records: [
      {
        header: { id: 'sess_1', cwd: 'D:/AI/project', title: '任务 A' },
        live: true,
        persisted: false,
      },
    ],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw(id) {
        assert.equal(id, 'sess_1')
        return { meta: { id }, filename: 'session.jsonl', content }
      },
    },
    sessions,
    attachments: attachmentsFor(),
  })

  const result = await resolveSessionLogPath(ctx, 'sess_1')
  assert.deepEqual(flushed, ['sess_1'])
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'sess_1')
  assert.equal(result.label, '任务 A')
  assert.equal(result.kind, 'jsonl-directory')
  assert.equal(result.cwd, 'D:/AI/project')
  assert.equal(result.rootPath, join(result.path, 'session.jsonl'))
  assert.deepEqual(result.layout, { root: 'session.jsonl', descendants: 0, media: 0 })
  assert.equal(await readFile(result.rootPath, 'utf8'), content)
  await cleanCache(ctx, 'sess_1')
})

test('preserves the backend raw filename for the root entry', async () => {
  const content = '{"seq":1}\n'
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_custom', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: 'sess_custom' }, filename: 'session.log', content }
      },
    },
    sessions: undefined,
    attachments: attachmentsFor(),
  })

  const result = await resolveSessionLogPath(ctx, 'sess_custom')
  assert.equal(result.ok, true)
  assert.equal(result.rootPath, join(result.path, 'session.log'))
  assert.deepEqual(result.layout, { root: 'session.log', descendants: 0, media: 0 })
  assert.equal(await readFile(result.rootPath, 'utf8'), content)
  await cleanCache(ctx, 'sess_custom')
})

test('rejects raw artifact filenames that can escape the materialized directory', async () => {
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_traverse', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: 'sess_traverse' }, filename: '../escape.txt', content: '{"seq":1}\n' }
      },
    },
    sessions: undefined,
    attachments: attachmentsFor(),
  })

  const result = await resolveSessionLogPath(ctx, 'sess_traverse')
  assert.equal(result.ok, false)
  assert.equal(result.status, 501)
  assert.match(result.error, /安全单层文件名/)
  await assert.rejects(readFile(join(ctx.resumeCacheRoot, 'escape.txt'), 'utf8'), /ENOENT/)
  await cleanCache(ctx, 'sess_traverse')
})

test('materializes descendants under official safe path segments and dedupes them', async () => {
  const flushed = []
  const rootContent = '{"seq":1}\n'
  const childContent = '{"child":1}\n'
  const duplicateNode = {
    session: { header: { id: 'child/id' }, live: true },
    descendants: [],
  }
  const ctx = ctxFor({
    records: [
      { header: { id: 'sess_parent', cwd: 'D:/AI/project' }, live: false, persisted: true },
    ],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw(id) {
        if (id === 'sess_parent') return { meta: { id }, filename: 'session.jsonl', content: rootContent }
        if (id === 'child/id') return { meta: { id }, filename: 'session.jsonl', content: childContent }
        return undefined
      },
    },
    sessions: {
      get(id) {
        return id === 'child/id' ? { id } : undefined
      },
      async flush(session) {
        flushed.push(session.id)
        return true
      },
    },
    trace: {
      descendants: [duplicateNode, duplicateNode],
    },
    attachments: attachmentsFor(),
  })

  const result = await resolveSessionLogPath(ctx, 'sess_parent')
  assert.equal(result.ok, true)
  assert.equal(result.layout.descendants, 1)
  assert.deepEqual(flushed, ['child/id'])
  assert.equal(
    await readFile(join(result.path, 'subagents', safePathSegment('child/id'), 'session.jsonl'), 'utf8'),
    childContent,
  )
  await cleanCache(ctx, 'sess_parent')
})

test('requires the attachments service before materialization', async () => {
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
      },
    },
    sessions: undefined,
    attachments: undefined,
  })

  const result = await resolveSessionLogPath(ctx, 'sess_1')
  assert.equal(result.ok, false)
  assert.equal(result.status, 501)
  assert.match(result.error, /附件存储/)
})

test('materializes known images and fails closed on unknown media types', async () => {
  const content =
    '{"type":"session","version":0,"id":"sess_img","createdAt":1,"data":{"content":[' +
    '{"type":"image","attachment":{"attachmentId":"img_1","mediaType":"image/png"}},' +
    '{"type":"image","attachment":{"attachmentId":"img_2","mediaType":"image/unknown"}}' +
    ']}}\n'
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_img', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: 'sess_img' }, filename: 'session.jsonl', content }
      },
    },
    sessions: undefined,
    attachments: {
      async readImage(ref) {
        // The unknown media type is skipped before readImage, so only img_1 is read.
        assert.equal(ref.attachmentId, 'img_1')
        return { data: new Uint8Array([137]) }
      },
    },
  })

  const result = await resolveSessionLogPath(ctx, 'sess_img')
  assert.equal(result.ok, true)
  assert.equal(result.layout.media, 1)
  assert.deepEqual(
    Buffer.from(await readFile(join(result.path, 'media', 'img_1.png'))),
    Buffer.from([137]),
  )
  // Unknown media types must not be materialized as a `.undefined` file.
  await assert.rejects(readFile(join(result.path, 'media', 'img_2.undefined')))
  await cleanCache(ctx, 'sess_img')
})

test('sanitizes media attachment ids for Windows-safe directory paths', async () => {
  const content =
    '{"type":"session","version":0,"id":"sess_sha","createdAt":1,"data":{"content":[' +
    '{"type":"image","attachment":{"attachmentId":"sha256:4628d0aa","mediaType":"image/png"}}' +
    ']}}\n'
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_sha', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: 'sess_sha' }, filename: 'session.jsonl', content }
      },
    },
    sessions: undefined,
    attachments: {
      async readImage(ref) {
        assert.equal(ref.attachmentId, 'sha256:4628d0aa')
        return { data: new Uint8Array([137, 80, 78, 71]) }
      },
    },
  })

  const result = await resolveSessionLogPath(ctx, 'sess_sha')
  assert.equal(result.ok, true)
  assert.equal(result.layout.media, 1)
  const mediaDir = join(result.path, 'media')
  const files = await readdir(mediaDir)
  assert.deepEqual(files, [`${safePathSegment('sha256:4628d0aa')}.png`])
  await cleanCache(ctx, 'sess_sha')
})

test('safe path segments cannot collide for ids that sanitize to the same text', () => {
  const first = safePathSegment('child/id')
  const second = safePathSegment('child_id')
  const third = safePathSegment('sha256:a')
  const fourth = safePathSegment('sha256_a')
  assert.notEqual(first, second)
  assert.notEqual(third, fourth)
  assert.ok(first.startsWith('~'))
  assert.ok(third.startsWith('~'))
})

test('returns 501 when the official raw artifact read fails', async () => {
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_bad', cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        throw new Error('backend exploded')
      },
    },
    sessions: undefined,
    attachments: attachmentsFor(),
  })

  const result = await resolveSessionLogPath(ctx, 'sess_bad')
  assert.equal(result.ok, false)
  assert.equal(result.status, 501)
  assert.match(result.error, /无法读取会话日志工件/)
})

test('returns 404 when the official raw artifact is absent', async () => {
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1' }, live: false, persisted: false }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return undefined
      },
    },
    sessions: undefined,
    attachments: attachmentsFor(),
  })

  assert.deepEqual(await resolveSessionLogPath(ctx, 'sess_1'), {
    ok: false,
    status: 404,
    error: '会话日志尚未落盘或不存在',
  })
})

test('rejects deployments without official raw artifact reads', async () => {
  const ctx = ctxFor({
    records: [{ header: { id: 'sess_1' }, live: true }],
    persistence: { supportsRawArtifacts: true },
    sessions: undefined,
  })

  assert.equal((await resolveSessionLogPath(ctx, 'sess_1')).ok, false)
  assert.equal((await resolveSessionLogPath(ctx, 'sess_1')).status, 501)
})

test('returns not found for an unknown session id', async () => {
  const ctx = ctxFor({
    records: [],
    persistence: { supportsRawArtifacts: true },
    sessions: undefined,
  })

  assert.deepEqual(await resolveSessionLogPath(ctx, 'missing'), {
    ok: false,
    status: 404,
    error: '会话不存在或不可读',
  })
})

test('distinguishes a query-service failure from "not found"', async () => {
  // The session-query service throws: this must surface as a 500, never be
  // flattened into the misleading 404 "会话不存在或不可读" of a genuine miss.
  const throwingQuery = {
    listSessions: async () => {
      throw new Error('backend exploded')
    },
  }
  const throwingCtx = ctxFor({
    records: [],
    persistence: { supportsRawArtifacts: true },
    sessions: undefined,
  })
  throwingCtx.get = (name) => (name === 'sessionQuery' ? throwingQuery : undefined)
  throwingCtx.sessionQuery = throwingQuery

  const failed = await resolveSessionLogPath(throwingCtx, 'sess_1')
  assert.equal(failed.ok, false)
  assert.equal(failed.status, 500)
  assert.match(failed.error, /无法查询会话信息/)

  // An absent query service is the same class of failure, not a 404.
  const noQueryCtx = ctxFor({
    records: [],
    persistence: { supportsRawArtifacts: true },
    sessions: undefined,
  })
  noQueryCtx.get = () => undefined
  noQueryCtx.sessionQuery = undefined

  const unavailable = await resolveSessionLogPath(noQueryCtx, 'sess_1')
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.status, 500)
})

test('materializes through a getter-only runtime context proxy', async () => {
  const sessionId = `sess_proxy_${randomUUID()}`
  const base = ctxFor({
    records: [{ header: { id: sessionId, cwd: 'D:/AI/project' }, live: false, persisted: true }],
    persistence: {
      supportsRawArtifacts: true,
      async readRaw() {
        return { meta: { id: sessionId }, filename: 'session.jsonl', content: '{"seq":1}\n' }
      },
    },
    sessions: undefined,
    attachments: attachmentsFor(),
  })
  const runtimeCtx = new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === 'resumeCacheRoot') {
        throw new Error('cannot get property "resumeCacheRoot" without inject')
      }
      return Reflect.get(base, prop, receiver)
    },
  })

  const result = await resolveSessionLogPath(runtimeCtx, sessionId)
  assert.equal(result.ok, true)
  await rm(join(tmpdir(), 'dsh-session-resume', sessionId), { recursive: true, force: true })
})
