import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeResumeConfig,
  readResumeConfig,
  writeResumeConfig,
  RESUME_INSTRUCTION,
} from '../lib/host/config.js'
import { buildResumePrompt } from '../lib/shared/resume-text.js'
import { resolveEffectiveInstruction } from '../lib/client/resume-client.js'
import { registerResumeApi } from '../lib/host/api.js'

function cacheRoot() {
  return join(tmpdir(), 'dsh-session-resume-config-tests', randomUUID())
}

async function clean(root) {
  await rm(root, { recursive: true, force: true })
}

test('defaults the config to the frozen instruction and 10-snapshot retention', async () => {
  const root = cacheRoot()
  const config = await readResumeConfig(root)
  assert.equal(config.resumeInstruction, RESUME_INSTRUCTION)
  assert.equal(config.snapshotRetention, 10)
  await clean(root)
})

test('normalizes invalid config values fail-closed to defaults', () => {
  const normalized = normalizeResumeConfig({ resumeInstruction: '', snapshotRetention: 999 })
  assert.equal(normalized.resumeInstruction, RESUME_INSTRUCTION)
  assert.equal(normalized.snapshotRetention, 10)
})

test('normalization always returns the full effective config', () => {
  const retentionOnly = normalizeResumeConfig({ snapshotRetention: 3 })
  assert.equal(retentionOnly.resumeInstruction, RESUME_INSTRUCTION)
  assert.equal(retentionOnly.snapshotRetention, 3)
  const instructionOnly = normalizeResumeConfig({ resumeInstruction: '只总结' })
  assert.equal(instructionOnly.resumeInstruction, '只总结')
  assert.equal(instructionOnly.snapshotRetention, 10)
})

test('writes and reads a custom resume instruction', async () => {
  const root = cacheRoot()
  const saved = await writeResumeConfig(
    { resumeInstruction: '只总结，不要继续干活', snapshotRetention: 3 },
    root,
  )
  assert.equal(saved.resumeInstruction, '只总结，不要继续干活')
  const read = await readResumeConfig(root)
  assert.equal(read.resumeInstruction, '只总结，不要继续干活')
  assert.equal(read.snapshotRetention, 3)
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  assert.equal(raw.resumeInstruction, '只总结，不要继续干活')
  await clean(root)
})

test('concurrent config writes use collision-free temp files', async () => {
  const root = cacheRoot()
  await Promise.all([
    writeResumeConfig({ resumeInstruction: '配置 A' }, root),
    writeResumeConfig({ resumeInstruction: '配置 B' }, root),
  ])
  const read = await readResumeConfig(root)
  // Writes to one cache root are serialized last-writer-wins, so the final
  // committed value is deterministic ('配置 B') and the temp files never collide.
  assert.equal(read.resumeInstruction, '配置 B')
  await clean(root)
})

test('buildResumePrompt accepts a custom instruction and falls back to the default', () => {
  const path = String.raw`D:\logs\sess_1\session.jsonl`
  assert.equal(buildResumePrompt(path), `${path} ${RESUME_INSTRUCTION}`)
  assert.equal(
    buildResumePrompt(path, { instruction: '只总结' }),
    `${path} 只总结`,
  )
  assert.equal(
    buildResumePrompt('@[a](dsh-session:x)', { instruction: '只总结' }),
    '@[a](dsh-session:x) 只总结',
  )
})

test('resolveEffectiveInstruction returns the custom instruction from the config API', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: true, config: { resumeInstruction: '只总结' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  assert.equal(await resolveEffectiveInstruction(fetchImpl), '只总结')
})

test('resolveEffectiveInstruction falls back to the default on API failure', async () => {
  const fetchImpl = async () => new Response('boom', { status: 500 })
  assert.equal(await resolveEffectiveInstruction(fetchImpl), RESUME_INSTRUCTION)
})

test('registerResumeApi serves GET /config and accepts PUT /config', async () => {
  const root = cacheRoot()
  const requests = []
  const server = {
    register(route) {
      requests.push(route)
      return () => undefined
    },
  }
  const ctx = {
    webServer: server,
    resumeCacheRoot: root,
    logger: { info() {}, warn() {}, error() {} },
  }
  const unregister = registerResumeApi(ctx)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].kind, 'prefix')
  assert.equal(requests[0].path, '/session-resume/api')

  const route = requests[0]
  const reqFor = (method, url, body) => ({
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
    resume() {},
    removeAllListeners() {},
    ...(body ? { _body: body } : {}),
  })
  const resFor = () => {
    const chunks = []
    return {
      writeHead(code, headers) {
        this.code = code
        this.headers = headers
      },
      end(payload) {
        this.payload = payload
        chunks.push(payload)
      },
      get body() {
        return JSON.parse(chunks.join(''))
      },
    }
  }

  // GET default
  const getRes = resFor()
  await route.handler(reqFor('GET', '/session-resume/api/config'), getRes)
  assert.equal(getRes.code, 200)
  assert.equal(getRes.body.ok, true)
  assert.equal(getRes.body.config.resumeInstruction, RESUME_INSTRUCTION)

  // PUT custom
  const putRes = resFor()
  let putBody = ''
  const putReq = reqFor('PUT', '/session-resume/api/config')
  putReq.on = (event, listener) => {
    if (event === 'data') listener(JSON.stringify({ resumeInstruction: '自定义续跑' }))
    if (event === 'end') listener()
  }
  await route.handler(putReq, putRes)
  assert.equal(putRes.code, 200)
  assert.equal(putRes.body.config.resumeInstruction, '自定义续跑')

  // GET echoes the saved value
  const get2Res = resFor()
  await route.handler(reqFor('GET', '/session-resume/api/config'), get2Res)
  assert.equal(get2Res.body.config.resumeInstruction, '自定义续跑')

  unregister()
  await clean(root)
})

test('registerResumeApi rejects batch snapshotIds that are not requested sessions', async () => {
  const root = cacheRoot()
  const requests = []
  const server = {
    register(route) {
      requests.push(route)
      return () => undefined
    },
  }
  const ctx = {
    webServer: server,
    resumeCacheRoot: root,
    logger: { info() {}, warn() {}, error() {} },
  }
  const unregister = registerResumeApi(ctx)
  const route = requests[0]

  const reqFor = (body) => ({
    method: 'POST',
    url: '/session-resume/api/resume-batch',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data') listener(JSON.stringify(body))
      if (event === 'end') listener()
    },
    resume() {},
    removeAllListeners() {},
  })
  const resFor = () => {
    const chunks = []
    return {
      writeHead(code, headers) {
        this.code = code
        this.headers = headers
      },
      end(payload) {
        this.payload = payload
        chunks.push(payload)
      },
      get body() {
        return JSON.parse(chunks.join(''))
      },
    }
  }

  const badRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a'], snapshotIds: { sess_unknown: '1000' } }),
    badRes,
  )
  assert.equal(badRes.code, 400)
  assert.match(badRes.body.error, /未知会话/)

  const badValueRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a'], snapshotIds: { sess_a: 123 } }),
    badValueRes,
  )
  assert.equal(badValueRes.code, 400)
  assert.match(badValueRes.body.error, /非空字符串/)

  const nonStringSessionRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a', 123] }),
    nonStringSessionRes,
  )
  assert.equal(nonStringSessionRes.code, 400)
  assert.match(nonStringSessionRes.body.error, /非空字符串数组/)

  const duplicateSessionRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a', 'sess_a'] }),
    duplicateSessionRes,
  )
  assert.equal(duplicateSessionRes.code, 400)
  assert.match(duplicateSessionRes.body.error, /重复会话/)

  const nonObjectSnapshotsRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a'], snapshotIds: [] }),
    nonObjectSnapshotsRes,
  )
  assert.equal(nonObjectSnapshotsRes.code, 400)
  assert.match(nonObjectSnapshotsRes.body.error, /snapshotIds 必须是对象/)

  const unsafeSnapshotRes = resFor()
  await route.handler(
    reqFor({ sessionIds: ['sess_a'], snapshotIds: { sess_a: '../escape' } }),
    unsafeSnapshotRes,
  )
  assert.equal(unsafeSnapshotRes.code, 400)
  assert.match(unsafeSnapshotRes.body.error, /只能包含字母、数字、下划线或连字符|snapshotId/)

  unregister()
  await clean(root)
})

test('registerResumeApi rejects an unsafe /complete attemptId through the shared token guard', async () => {
  const root = cacheRoot()
  const requests = []
  const server = {
    register(route) {
      requests.push(route)
      return () => undefined
    },
  }
  const ctx = {
    webServer: server,
    resumeCacheRoot: root,
    logger: { info() {}, warn() {}, error() {} },
  }
  const unregister = registerResumeApi(ctx)
  const route = requests[0]

  const reqFor = (body, method = 'POST') => ({
    method,
    url: `/session-resume/api/${method === 'POST' ? 'complete' : 'config'}`,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data') listener(JSON.stringify(body))
      if (event === 'end') listener()
    },
    resume() {},
    removeAllListeners() {},
  })
  const resFor = () => {
    const chunks = []
    return {
      writeHead(code, headers) {
        this.code = code
        this.headers = headers
      },
      end(payload) {
        this.payload = payload
        chunks.push(payload)
      },
      get body() {
        return JSON.parse(chunks.join(''))
      },
    }
  }

  // Unsafe (path-traversal-shaped) attemptId is rejected before any order work.
  const unsafeRes = resFor()
  await route.handler(
    reqFor({ attemptId: '../escape', status: 'accepted', targetSessionId: 'new_1' }),
    unsafeRes,
  )
  assert.equal(unsafeRes.code, 400)
  assert.match(unsafeRes.body.error, /只能包含字母、数字、下划线或连字符/)

  // A missing attemptId is a distinct 400 (mandatory here, unlike /resume).
  const missingRes = resFor()
  await route.handler(reqFor({ status: 'accepted', targetSessionId: 'new_1' }), missingRes)
  assert.equal(missingRes.code, 400)
  assert.match(missingRes.body.error, /attemptId 必填/)

  unregister()
  await clean(root)
})
