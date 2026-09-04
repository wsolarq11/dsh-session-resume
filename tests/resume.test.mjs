import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildResumePrompt,
  RESUME_INSTRUCTION,
} from '../lib/shared/resume-text.js'
import { connectResumeSession, promptResumeSession } from '../lib/client/resume-client.js'

class FakeResumeSessions {
  constructor({ promptResult = { ok: true } } = {}) {
    this.opened = []
    this.promptCalls = []
    this.createdCalls = []
    this.promptResult = promptResult
  }

  async create(opts) {
    this.createdCalls.push(opts)
    return 'new_session_1'
  }

  open(id) {
    this.opened.push(id)
  }

  binding(id) {
    return {
      session: {
        prompt: async (content, mode) => {
          this.promptCalls.push({ id, content, mode })
          return this.promptResult
        },
      },
    }
  }
}

test('locks the exact resume instruction text so wording cannot drift', () => {
  assert.equal(
    RESUME_INSTRUCTION,
    '请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。',
  )
})

test('builds a path prompt that carries the log path and shared instruction', () => {
  const path = String.raw`D:\logs\sess_1\session.jsonl.zstd`
  assert.equal(
    buildResumePrompt(path),
    `${path} ${RESUME_INSTRUCTION}`,
  )
})

test('builds a mention prompt from a canonical mention', () => {
  assert.equal(
    buildResumePrompt('@[旧会话](dsh-session:abc)'),
    `@[旧会话](dsh-session:abc) ${RESUME_INSTRUCTION}`,
  )
})

test('creates, opens and prompts a new session via the shared connect+prompt flow', async () => {
  const fake = new FakeResumeSessions()
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1' })
  const outcome = await promptResumeSession(fake, newId, '继续')
  assert.equal(newId, 'new_session_1')
  assert.equal(outcome.accepted, true)
  assert.deepEqual(fake.createdCalls, [{ workspaceId: 'ws_1' }])
  assert.deepEqual(fake.opened, ['new_session_1'])
  assert.equal(fake.promptCalls.length, 1)
  assert.equal(fake.promptCalls[0].id, 'new_session_1')
  assert.equal(fake.promptCalls[0].mode, 'queue')
  assert.equal(fake.promptCalls[0].content[0].type, 'text')
})

test('prefers workspaceId over cwd when creating a resume session', async () => {
  const fake = new FakeResumeSessions()
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1', cwd: 'D:/AI/project' })
  assert.equal(newId, 'new_session_1')
  assert.deepEqual(fake.createdCalls, [{ workspaceId: 'ws_1' }])
})

test('reuses an existing blank session through connectWorkspace', async () => {
  const fake = new FakeResumeSessions()
  const workspaces = {
    connectWorkspace: async (workspaceId) => {
      assert.equal(workspaceId, 'ws_1')
      return 'reused_blank_1'
    },
  }
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1' }, workspaces)
  assert.equal(newId, 'reused_blank_1')
  assert.equal(fake.createdCalls.length, 0)
  assert.equal(fake.promptCalls.length, 0)
})

test('fails closed when no workspace id is known (plan must carry workspaceId)', async () => {
  const fake = new FakeResumeSessions()
  const workspaces = { connectWorkspace: async () => 'unused' }
  await assert.rejects(
    connectResumeSession(fake, { cwd: 'D:/AI/project' }, workspaces),
    /没有续跑目标工作区/,
  )
  assert.equal(fake.createdCalls.length, 0)
})

test('reports structured failure when the prompt rejects', async () => {
  const fake = new FakeResumeSessions({ promptResult: { ok: false } })
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1' })
  const outcome = await promptResumeSession(fake, newId, '继续')
  assert.equal(outcome.accepted, false)
  assert.match(outcome.error, /没有可用的发送面/)
})

test('reports structured failure when the new session has no prompt face', async () => {
  const fake = new FakeResumeSessions()
  fake.binding = () => undefined
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1' })
  const outcome = await promptResumeSession(fake, newId, '继续')
  assert.equal(outcome.accepted, false)
})

test('promptResumeSession captures a throwing prompt as a failed order step', async () => {
  const fake = new FakeResumeSessions()
  fake.binding = (id) => ({
    session: {
      prompt: async () => {
        throw new Error('wire closed')
      },
    },
  })
  const result = await promptResumeSession(fake, 'new_session_1', '继续')
  assert.equal(result.accepted, false)
  assert.equal(result.error, 'wire closed')
})

test('fails explicitly when the client sessions service is unavailable', async () => {
  await assert.rejects(
    connectResumeSession(undefined, { workspaceId: 'ws_1' }),
    /客户端会话服务不可用/,
  )
  const prompted = await promptResumeSession(undefined, 'new_session_1', '继续')
  assert.equal(prompted.accepted, false)
  assert.equal(prompted.error, '新会话没有可用的发送面')
})

test('prefers a workspace-carrying plan and never falls back to a bare cwd', async () => {
  const fake = new FakeResumeSessions()
  const newId = await connectResumeSession(fake, { workspaceId: 'ws_1' })
  assert.equal(newId, 'new_session_1')
  assert.deepEqual(fake.createdCalls, [{ workspaceId: 'ws_1' }])
})
