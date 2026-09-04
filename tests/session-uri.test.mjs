import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionPayload,
  encodeSessionUri,
  formatMention,
} from '../lib/shared/session-uri.js'

function officialUri(sessionId) {
  return 'dsh-session:' + Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
}

test('encodes canonical session URIs like the official service', () => {
  for (const sessionId of ['sess_123', 'a+b/c=', '中文会话-1', 'emoji-🎯']) {
    assert.equal(encodeSessionUri(sessionId), officialUri(sessionId))
    assert.equal(decodeSessionPayload(encodeSessionUri(sessionId).slice('dsh-session:'.length)), sessionId)
  }
})

test('decodes official UTF-8 session URIs without mojibake', () => {
  const sessionId = '会话-1'
  const uri = officialUri(sessionId)
  assert.equal(decodeSessionPayload(uri.slice('dsh-session:'.length)), sessionId)
})

test('escapes markdown-sensitive mention labels', () => {
  assert.equal(
    formatMention('sess_1', 'a]b\\c'),
    '@[a\\]b\\\\c](dsh-session:InNlc3NfMSI)',
  )
})
