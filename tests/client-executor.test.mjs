import test from 'node:test'
import assert from 'node:assert/strict'
import { createResumeExecutorScope, runResumeInFlight, runResumeOnce } from '../lib/client/resume-executor.js'

class FakeResumeSessions {
  constructor({ promptAccepted = true } = {}) {
    this.seq = 0
    this.createdCalls = []
    this.opened = []
    this.promptCalls = []
    this.promptAccepted = promptAccepted
  }

  async create(opts) {
    this.seq += 1
    this.createdCalls.push(opts)
    return `new_session_${this.seq}`
  }

  open(id) {
    this.opened.push(id)
  }

  binding(id) {
    return {
      session: {
        prompt: async (content, mode) => {
          this.promptCalls.push({ id, content, mode })
          return this.promptAccepted ? { ok: true } : { ok: false }
        },
      },
    }
  }
}

function planResponse() {
  return {
    ok: true,
    attemptId: 'attempt_1',
    sources: [{ sessionId: 'sess_1', label: 'A', path: 'D:/snap', kind: 'jsonl-directory' }],
    target: { workspaceId: 'ws_1' },
  }
}

async function fakeFetch(url, init = {}) {
  if (String(url).endsWith('/resume')) {
    return new Response(JSON.stringify(planResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (String(url).endsWith('/complete')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 500 })
}

globalThis.fetch = fakeFetch

function execution() {
  return {
    endpoint: '/resume',
    body: { sessionId: 'sess_1' },
    attemptIdPrefix: 'resume-',
    eventLabel: '续跑',
    buildText: async () => '继续',
  }
}

test('resolves, connects, and prompts exactly once on success', async () => {
  const sessions = new FakeResumeSessions()
  const result = await runResumeOnce({ sessions, workspaces: undefined }, execution())
  assert.equal(result.newId, 'new_session_1')
  assert.equal(sessions.createdCalls.length, 1)
  assert.equal(sessions.promptCalls.length, 1)
  assert.equal(sessions.opened.length, 1)
})

test('does not create a second session when the prompt keeps failing', async () => {
  const sessions = new FakeResumeSessions({ promptAccepted: false })
  await assert.rejects(
    runResumeOnce({ sessions, workspaces: undefined }, execution()),
    /发送失败/,
  )
  assert.equal(sessions.createdCalls.length, 1)
  assert.equal(sessions.opened.length, 1)
  assert.equal(sessions.promptCalls.length, 3)
})

test('retries the accepted /complete report with the same attemptId and only resolves after confirmation', async () => {
  const completeCalls = []
  const failNext = { remaining: 2 }
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? '{}')
    if (String(url).endsWith('/resume')) {
      return okResponse(planResponse())
    }
    if (String(url).endsWith('/complete')) {
      completeCalls.push(body.attemptId)
      if (failNext.remaining > 0) {
        failNext.remaining -= 1
        return new Response(JSON.stringify({ ok: false, error: 'flare down' }), { status: 503 })
      }
      return okResponse({ attemptId: body.attemptId, ok: true, status: 'accepted' })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 500 })
  }
  const sessions = new FakeResumeSessions()
  const result = await runResumeOnce({ sessions, workspaces: undefined }, execution())
  assert.equal(completeCalls.length, 3)
  // All three retries reuse the same attemptId (no duplicate orders/sessions).
  assert.equal(new Set(completeCalls).size, 1)
  assert.equal(sessions.createdCalls.length, 1)
  assert.ok(result.newId)
})

test('rejects instead of reporting success when the Host never confirms the accepted report', async () => {
  const completeCalls = []
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? ''))
    if (String(url).endsWith('/resume')) {
      return okResponse(planResponse())
    }
    if (String(url).endsWith('/complete')) {
      completeCalls.push(body.attemptId)
      return new Response(JSON.stringify({ ok: false, error: 'unavailable' }), { status: 503 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 500 })
  }
  const sessions = new FakeResumeSessions()
  await assert.rejects(
    runResumeOnce({ sessions, workspaces: undefined }, execution()),
    /未能确认续跑完成|已重试/,
  )
  // 3 accepted-report retries + 1 failed best-effort report, all the same attemptId.
  assert.equal(completeCalls.length, 4)
  assert.equal(new Set(completeCalls).size, 1)
})

test('NEW-C: runResumeOnce honors an injected scope attempt-id generator', async () => {
  const usedAttemptIds = []
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'))
    if (String(url).endsWith('/resume')) {
      usedAttemptIds.push(body.attemptId)
      return okResponse(planResponse())
    }
    if (String(url).endsWith('/complete')) {
      return okResponse({ ok: true })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 500 })
  }
  const sessions = new FakeResumeSessions()
  const scope = createResumeExecutorScope()
  let generated = 0
  scope.attemptId = (prefix) => `${prefix}deterministic-${++generated}`
  const result = await runResumeOnce({ sessions, workspaces: undefined }, execution(), scope)
  assert.equal(usedAttemptIds[0], 'resume-deterministic-1')
  assert.equal(sessions.createdCalls.length, 1)
  assert.ok(result.newId)
})

test('NEW-C: runResumeInFlight dedup is isolated per executor scope', async () => {
  const scopeA = createResumeExecutorScope()
  const scopeB = createResumeExecutorScope()
  let callsA = 0
  let callsB = 0
  const make = (id) => () =>
    Promise.resolve({
      plan: planResponse(),
      newId: id,
    })
  const ra1 = runResumeInFlight('k', () => { callsA += 1; return make('a')() }, scopeA)
  const ra2 = runResumeInFlight('k', () => { callsA += 1; return make('a')() }, scopeA)
  const rb = runResumeInFlight('k', () => { callsB += 1; return make('b')() }, scopeB)
  assert.equal(callsA, 1)     // same scope dedupes the in-flight order
  assert.equal(callsB, 1)     // a different scope gets its own in-flight entry
  assert.equal(ra1, ra2)      // same scope shares the same promise
  assert.notEqual(ra1, rb)    // distinct scopes produce distinct promises
})

function okResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
