import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countDistinctLogSessions,
  findLogUrlMatch,
  findLogUrlMatches,
  parseLogUrl,
} from '../lib/index.js'

const plain = '/api/session.export?sessionId=sess_1&includeDescendants=true'
const absolute = 'http://127.0.0.1:3080/api/session.export?sessionId=sess_2&includeDescendants=true'

test('parses host-less and absolute official export URLs', () => {
  assert.deepEqual(parseLogUrl(plain, 3), {
    id: 'sess_1',
    start: 3,
    end: 3 + plain.length,
  })
  assert.deepEqual(findLogUrlMatch(absolute), {
    id: 'sess_2',
    start: 0,
    end: absolute.length,
  })
})

test('findLogUrlMatch is reusable and does not retain global regex state', () => {
  assert.equal(findLogUrlMatch(plain)?.id, 'sess_1')
  assert.equal(findLogUrlMatch(plain)?.id, 'sess_1')
})

test('strips Markdown and CJK punctuation from the URL token', () => {
  const markdown = '[日志](http://127.0.0.1:3080/api/session.export?sessionId=sess_1)'
  const chinese = 'http://127.0.0.1:3080/api/session.export?sessionId=sess_1）。'
  assert.equal(findLogUrlMatch(markdown)?.id, 'sess_1')
  assert.equal(findLogUrlMatch(chinese)?.id, 'sess_1')
})

test('finds and deduplicates multiple URLs', () => {
  const text = `${plain} 然后 ${absolute} 再贴一次 ${plain}`
  const hits = findLogUrlMatches(text)
  assert.equal(hits.length, 3)
  assert.deepEqual(hits.map((hit) => hit.id), ['sess_1', 'sess_2', 'sess_1'])
  assert.equal(countDistinctLogSessions(text), 2)
})
