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
} from '../lib/io/fs/config.js'
import { buildResumePrompt } from '../lib/pure/text/resume-text.js'
import { resolveEffectiveInstruction } from '../lib/orchestration/client/resume-client.js'

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

test('resolveEffectiveInstruction returns the frozen default once the /config HTTP is removed', async () => {
  assert.equal(await resolveEffectiveInstruction(), RESUME_INSTRUCTION)
})

test('resolveEffectiveInstruction uses the supplied custom instruction when present', async () => {
  assert.equal(await resolveEffectiveInstruction('只总结'), '只总结')
})
