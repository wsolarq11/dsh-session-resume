import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findLogPathMatches,
  isSessionLogPath,
} from '../lib/shared/session-path.js'

const pathMatch = (text) => findLogPathMatches(text)[0] ?? null

const windows = String.raw`D:\AI\projects\demo\sess_1\session.jsonl.zstd`
const posix = '/home/user/.dsh/sessions/project/sess_2/session.jsonl'

test('recognizes Windows and POSIX absolute session log paths', () => {
  assert.equal(isSessionLogPath(windows), true)
  assert.equal(isSessionLogPath(posix), true)
  assert.equal(isSessionLogPath('session.jsonl'), false)
  assert.equal(isSessionLogPath('relative/session.jsonl.zstd'), false)
})

test('finds a path inside surrounding text and keeps the exact span', () => {
  const text = `请继续 ${windows}，不要重贴。`
  const hit = pathMatch(text)
  assert.ok(hit)
  assert.equal(hit.path, windows)
  assert.equal(text.slice(hit.start, hit.end), windows)
})

test('keeps spaces inside a Windows path', () => {
  const spaced = String.raw`C:\Program Files\DeepSeek\session-1\session.jsonl`
  const hit = pathMatch(`继续 ${spaced}`)
  assert.equal(hit?.path, spaced)
})

test('does not capture text directly glued before an absolute path', () => {
  assert.equal(pathMatch(`继续${windows}`), null)
})

test('strips markdown-style parentheses around the path', () => {
  const hit = pathMatch(`[日志](${posix})`)
  assert.equal(hit?.path, posix)
})

test('finds and deduplicates multiple paths', () => {
  const text = `${windows} 和 ${windows} 和 ${posix}`
  const hits = findLogPathMatches(text)
  assert.equal(hits.length, 3)
  assert.deepEqual(hits.map((hit) => hit.path), [windows, windows, posix])
})
