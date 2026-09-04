import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countDistinctSessionRefs,
  countDistinctSourceRefs,
  findFirstSourceRef,
  findSessionIdFromMention,
  findSessionSourceRefs,
} from '../lib/pure/refs/source-ref.js'

const windows = String.raw`D:\AI\projects\demo\sess_1\session.jsonl.zstd`
const url = '/api/session.export?sessionId=sess_1&includeDescendants=true'

test('scans paths and URLs through one model and counts distinct mixed refs', () => {
  const text = `${windows} 然后 ${url} 再贴一次 ${windows} 再贴一次 ${url}`
  assert.equal(findFirstSourceRef(text)?.kind, 'path')
  assert.equal(countDistinctSourceRefs(text), 2)
  assert.equal(countDistinctSessionRefs(text), 1)
})

test('session-only scan still finds all URLs without counting paths', () => {
  const text = `${windows} 然后 ${url} 再贴一次 ${url}`
  const refs = findSessionSourceRefs(text)
  assert.equal(refs.length, 2)
  assert.deepEqual(refs.map((ref) => ref.id), ['sess_1', 'sess_1'])
  assert.equal(countDistinctSessionRefs(text), 1)
})

test('mentions are decoded through the same shared scanner', () => {
  const text = '继续 @[任务 A](dsh-session:InNlc3NfMSI)'
  assert.equal(findSessionIdFromMention(text), 'sess_1')
  assert.equal(findSessionIdFromMention('没有会话引用'), null)
})
