import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkspaceManifest,
  WORKSPACE_MANIFEST_FILE,
  WORKSPACE_GIT_FILE,
} from '../lib/io/fs/workspace-state.js'
import { buildResumePrompt } from '../lib/pure/text/resume-text.js'
import { materializeSessionLogExport } from '../lib/io/fs/log-materialize.js'

async function freshWorkspace() {
  const root = join(tmpdir(), 'dsh-session-resume-ws-tests', randomUUID())
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
  await writeFile(join(root, 'README.md'), '# demo\n', 'utf8')
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'junk.txt'), 'xx', 'utf8')
  return root
}

test('buildWorkspaceManifest lists files and directories and excludes node_modules', async () => {
  const root = await freshWorkspace()
  const manifest = await buildWorkspaceManifest({}, root)
  assert.equal(manifest.cwd, root)
  const paths = manifest.entries.map((entry) => entry.path.replace(/\\/g, '/'))
  assert.ok(paths.includes('src'))
  assert.ok(paths.includes('src/main.ts'))
  assert.ok(paths.includes('README.md'))
  assert.ok(!paths.includes('node_modules'))
  assert.ok(!paths.some((p) => p.startsWith('node_modules')))
  const main = manifest.entries.find((entry) => entry.path.endsWith('main.ts'))
  assert.equal(main.kind, 'file')
  assert.equal(main.size, 'export const x = 1\n'.length)
  await rm(root, { recursive: true, force: true })
})

test('buildWorkspaceManifest degrades to empty when cwd is missing', async () => {
  const manifest = await buildWorkspaceManifest({}, undefined)
  assert.equal(manifest.cwd, '')
  assert.deepEqual(manifest.entries, [])
})

test('buildWorkspaceManifest on a non-existing cwd returns truncated empty manifest', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-ws-tests', randomUUID(), 'nope')
  const manifest = await buildWorkspaceManifest({}, root)
  assert.equal(manifest.cwd, root)
  assert.deepEqual(manifest.entries, [])
})

test('workspace manifest does not traverse symlink or junction targets', async (t) => {
  const root = await freshWorkspace()
  const outside = join(tmpdir(), 'dsh-session-resume-ws-outside', randomUUID())
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    await symlink(outside, join(root, 'escape'), linkType)
  } catch {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    t.skip('symlink creation is not permitted in this environment')
    return
  }

  const manifest = await buildWorkspaceManifest({}, root)
  assert.ok(!manifest.entries.some((entry) => entry.path === 'escape' || entry.path.startsWith('escape')))

  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('workspace-state files are written into a materialized snapshot', async () => {
  const root = join(tmpdir(), 'dsh-session-resume-ws-tests', randomUUID())
  const wsRoot = await freshWorkspace()
  await mkdir(join(root, 'sess_1'), { recursive: true })
  const raw = { meta: { id: 'sess_1' }, filename: 'session.jsonl', content: '{"seq":1}\n' }
  const ctx = {
    get() {
      return undefined
    },
    resumeCacheRoot: root,
    attachments: {
      async readImage() {
        return { data: new Uint8Array([1]) }
      },
    },
  }
  const result = await materializeSessionLogExport(ctx, raw, 'sess_1', {
    cwd: wsRoot,
  })
  const manifestRaw = await readFile(join(result.path, 'workspace-state', WORKSPACE_MANIFEST_FILE), 'utf8')
  const manifest = JSON.parse(manifestRaw)
  assert.ok(Array.isArray(manifest.entries))
  assert.ok(manifest.entries.some((entry) => entry.path === 'README.md'))
  // git file may be absent outside a git repo; manifest must exist
  assert.ok(manifestRaw.length > 0)
  await rm(root, { recursive: true, force: true })
  await rm(wsRoot, { recursive: true, force: true })
})

test('buildResumePrompt appends the workspace pointer only when packaged', () => {
  const path = String.raw`D:\logs\sess_1\session.jsonl`
  const plain = buildResumePrompt(path)
  assert.doesNotMatch(plain, /workspace-state/)
  const extended = buildResumePrompt(path, { workspaceState: true })
  assert.match(extended, /workspace-state/)
  assert.match(extended, /文件清单与 git 状态/)
})
