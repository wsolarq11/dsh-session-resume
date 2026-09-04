import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasLegacySurfaceEvents,
  isUnidentifiedMessageEvent,
} from '../lib/shared/legacy-surface.js'

const LEGACY_USER = {
  type: 'user/message',
  seq: 105993,
  time: 1788068717916,
  data: {
    role: 'user',
    source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice' },
    content: [{ type: 'text', text: '<goal_complete>' }],
  },
  surfaceOp: 'append',
}

const LEGACY_ASSISTANT = {
  type: 'assistant/message',
  seq: 2,
  time: 1,
  data: {
    content: [{ type: 'text', text: 'hi' }],
    provenance: { source: 'model' },
  },
}

const LEGACY_TOOL = {
  type: 'tool/result',
  seq: 3,
  time: 1,
  data: { callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
}

test('detects the documented legacy user/message (no id) as unidentified', () => {
  assert.equal(isUnidentifiedMessageEvent(LEGACY_USER), true)
})

test('detects legacy assistant/message and tool/result shapes without a message id', () => {
  assert.equal(isUnidentifiedMessageEvent(LEGACY_ASSISTANT), true)
  assert.equal(isUnidentifiedMessageEvent(LEGACY_TOOL), true)
})

test('does not flag a healthy identified message or non-message events', () => {
  assert.equal(
    isUnidentifiedMessageEvent({
      type: 'user/message',
      seq: 1,
      data: { id: 'msg_1', role: 'user', content: [], source: { kind: 'user' } },
    }),
    false,
  )
  assert.equal(isUnidentifiedMessageEvent({ type: 'goal/change', seq: 1, data: {} }), false)
  // A user message without an id must be flagged even if it already has a role —
  // assertMessageEventShape still rejects it for the missing identity.
  assert.equal(
    isUnidentifiedMessageEvent({
      type: 'user/message',
      seq: 1,
      data: { role: 'user', source: { kind: 'plugin' }, content: [] },
    }),
    true,
  )
  // An assistant message with a proper message.id is healthy.
  assert.equal(
    isUnidentifiedMessageEvent({
      type: 'assistant/message',
      seq: 1,
      data: {
        message: {
          id: 'msg_2',
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'x', model: 'y' },
        },
      },
    }),
    false,
  )
  assert.equal(isUnidentifiedMessageEvent(null), false)
  assert.equal(isUnidentifiedMessageEvent(undefined), false)
  assert.equal(isUnidentifiedMessageEvent('nope'), false)
})

test('hasLegacySurfaceEvents scans a raw artifact for any unidentified message event', () => {
  const clean = '{"type":"user/message","seq":1,"data":{"id":"m1","role":"user","content":[],"source":{"kind":"user"}}}\n'
  assert.equal(hasLegacySurfaceEvents(clean), false)
  const dirty = `${clean}${JSON.stringify(LEGACY_USER)}\n`
  assert.equal(hasLegacySurfaceEvents(dirty), true)
})

test('torn or non-JSON lines are ignored, not treated as legacy evidence', () => {
  const torn = '{"seq":1}\nnot-json-line\n'
  assert.equal(hasLegacySurfaceEvents(torn), false)
})

test('empty artifact has no legacy surface', () => {
  assert.equal(hasLegacySurfaceEvents(''), false)
  assert.equal(hasLegacySurfaceEvents('\n\n'), false)
})