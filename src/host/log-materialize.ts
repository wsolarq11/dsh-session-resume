/** Host-side materialization of a session log into the official export directory layout. */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  flushLiveSession,
  readAttachments,
  readSessionPersistence,
  readSessionQuery,
} from './service.js'
import { DEFAULT_SNAPSHOT_RETENTION } from './config.js'
import type { SessionLogLayout } from '../shared/plan.js'
import {
  ensureCacheRoot,
  nextSnapshotSequence,
  pruneSnapshots,
  safePathSegment,
  snapshotDirectoryPath,
} from './snapshot-store.js'
import { readCacheRootSafe } from './service.js'
import {
  WORKSPACE_GIT_FILE,
  WORKSPACE_MANIFEST_FILE,
  WORKSPACE_STATE_DIR,
  buildWorkspaceManifest,
  renderGitStatusText,
} from './workspace-state.js'
import type {
  AttachmentStoreLike,
  HostContext,
  ImageAttachmentRefLike,
  SessionLineageNodeLike,
  SessionRawArtifactLike,
} from './types.js'

/** Known media types -> file extension; unknown types are skipped fail-closed. */
const MEDIA_TYPE_EXTENSIONS: Record<string, string | undefined> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
/**
 * In-flight materializations keyed by source session id, not by target path:
 * two concurrent resumes of the same session (header button + input dock, or
 * a single and a batch plan) must share one materialization instead of racing
 * two writes of the same log. Snapshot directories stay sequence-versioned
 * (each materialization is a new historical version), so the dedup key is the
 * source, and the version directory is chosen inside the shared task.
 */
const inflight = new Map<string, Promise<SessionLogMaterialization>>()

export interface SessionLogMaterialization {
  path: string
  rootPath: string
  layout: SessionLogLayout
  snapshotId: string
}

function assertSafeFilename(filename: string): void {
  const invalid =
    !filename ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    filename.length > 255
  if (invalid) {
    throw new Error(`日志工件文件名不是安全单层文件名: ${JSON.stringify(filename)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursive image-block walker over a `content` array. Purely depth-first:
 * any nested `content` array is descended, and any `{ type: 'image' }` block
 * with an attachment object is captured. Non-arrays and unknown blocks fail
 * closed (are ignored).
 */
function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRefLike>): void {
  if (!Array.isArray(content)) return
  const pending = [...content]
  while (pending.length > 0) {
    const value = pending.pop()
    if (!isRecord(value)) continue
    if (value.type === 'image' && typeof value.attachment === 'object' && value.attachment !== null) {
      const ref = value.attachment as ImageAttachmentRefLike
      refs.set(String(ref.attachmentId), ref)
    }
    if (Array.isArray(value.content)) pending.push(...value.content)
  }
}

/**
 * Enumerate the message content roots inside a runtime event `data` carrier.
 * Purely data-driven over the DSH session schema this plugin targets; an
 * unrecognized carrier shape fails closed (yields nothing) instead of
 * growing ad-hoc branches.
 */
function eventContentRoots(data: Record<string, unknown>): unknown[] {
  const roots = [data.content]
  const message = data.message
  if (isRecord(message) && Array.isArray(message.content)) roots.push(message.content)
  if (Array.isArray(data.inserted)) {
    for (const inserted of data.inserted) {
      if (isRecord(inserted) && Array.isArray(inserted.content)) roots.push(inserted.content)
    }
  }
  const chunk = data.chunk
  if (isRecord(chunk) && chunk.type === 'block-end') roots.push([chunk.block])
  return roots
}

function collectEventImageRefs(event: unknown, refs: Map<string, ImageAttachmentRefLike>): void {
  if (!isRecord(event)) return
  const data = event.data
  if (!isRecord(data)) return
  for (const root of eventContentRoots(data)) {
    collectImageRefs(root, refs)
  }
}

function imageRefsInArtifact(content: string): Map<string, ImageAttachmentRefLike> {
  const refs = new Map<string, ImageAttachmentRefLike>()
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    collectEventImageRefs(event, refs)
  }
  return refs
}

async function writeTextFile(targetDir: string, relPath: string, content: string): Promise<void> {
  const target = join(targetDir, ...relPath.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

async function writeArtifact(
  targetDir: string,
  raw: SessionRawArtifactLike,
  relPath: string,
  refs: Map<string, ImageAttachmentRefLike>,
): Promise<void> {
  assertSafeFilename(raw.filename)
  await writeTextFile(targetDir, relPath, raw.content)
  for (const ref of imageRefsInArtifact(raw.content).values()) refs.set(String(ref.attachmentId), ref)
}

async function writeDescendants(
  ctx: HostContext,
  nodes: readonly SessionLineageNodeLike[],
  targetDir: string,
  refs: Map<string, ImageAttachmentRefLike>,
  seen: Set<string>,
): Promise<number> {
  const persistence = readSessionPersistence(ctx)
  if (!persistence || typeof persistence.readRaw !== 'function') return 0
  let count = 0
  for (const node of nodes) {
    const id = node.session.header.id
    if (seen.has(id)) continue
    seen.add(id)
    await flushLiveSession(ctx, id)
    const raw = await persistence.readRaw(id)
    if (!raw) throw new Error(`subagent "${id}" has no stored log artifact`)
    await writeArtifact(
      targetDir,
      raw,
      `subagents/${safePathSegment(id)}/${raw.filename}`,
      refs,
    )
    count += 1
    count += await writeDescendants(ctx, node.descendants, targetDir, refs, seen)
  }
  return count
}

async function writeMedia(
  targetDir: string,
  readImage: (ref: ImageAttachmentRefLike) => Promise<{ data: Uint8Array }>,
  refs: Map<string, ImageAttachmentRefLike>,
  logger?: HostContext['logger'],
): Promise<number> {
  if (refs.size === 0) return 0
  let written = 0
  for (const ref of refs.values()) {
    const extension = MEDIA_TYPE_EXTENSIONS[ref.mediaType]
    if (!extension) {
      // Fail closed on unknown media types: never invent a `.undefined` filename.
      logger?.warn?.(
        JSON.stringify({
          event: 'session-resume.media-skipped-unknown-type',
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
        }),
      )
      continue
    }
    // readImage is guaranteed by materializeSessionLogExport's single fail-closed guard.
    const stored = await readImage(ref)
    const target = join(targetDir, 'media', `${safePathSegment(String(ref.attachmentId))}.${extension}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(stored.data))
    written += 1
  }
  return written
}

async function writeWorkspaceState(
  ctx: HostContext,
  targetDir: string,
  cwd: string | undefined,
): Promise<void> {
  if (!cwd) return
  try {
    const manifest = await buildWorkspaceManifest(ctx, cwd)
    const stateDir = join(targetDir, WORKSPACE_STATE_DIR)
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, WORKSPACE_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    )
    if (manifest.git) {
      await writeFile(join(stateDir, WORKSPACE_GIT_FILE), renderGitStatusText(manifest.git), 'utf8')
    }
  } catch {
    // Workspace state is best-effort; never fail the log snapshot for it.
  }
}

export async function materializeSessionLogExport(
  ctx: HostContext,
  root: SessionRawArtifactLike,
  sessionId: string,
  options: { retention?: number; snapshotId?: string | number; cwd?: string } = {},
): Promise<SessionLogMaterialization> {
  const attachments = readAttachments(ctx)
  if (!attachments || typeof attachments.readImage !== 'function') {
    throw new Error('会话日志导出需要附件存储，但附件服务不可用')
  }
  const readImage = attachments.readImage
  const cacheRoot = readCacheRootSafe(ctx)
  const pending = inflight.get(sessionId)
  if (pending) return pending
  const task = (async () => {
    const tempPath = join(cacheRoot, `.${safePathSegment(sessionId)}.${randomUUID()}.tmp`)
    await ensureCacheRoot(cacheRoot)
    try {
      const snapshotId =
        options.snapshotId !== undefined
          ? String(options.snapshotId)
          : await nextSnapshotSequence(cacheRoot, sessionId)
      const targetPath = snapshotDirectoryPath(cacheRoot, sessionId, snapshotId)
      const refs = new Map<string, ImageAttachmentRefLike>()
      await writeArtifact(tempPath, root, root.filename, refs)
      const query = readSessionQuery(ctx)
      let descendants = 0
      if (query && typeof query.traceSession === 'function') {
        const trace = await query.traceSession(sessionId)
        descendants = await writeDescendants(
          ctx,
          trace.descendants,
          tempPath,
          refs,
          new Set([sessionId]),
        )
      }
      const media = await writeMedia(tempPath, readImage, refs, ctx.logger)
      await writeWorkspaceState(ctx, tempPath, options.cwd)
      await mkdir(dirname(targetPath), { recursive: true })
      await rename(tempPath, targetPath)
      const retention = options.retention ?? DEFAULT_SNAPSHOT_RETENTION
      await pruneSnapshots(cacheRoot, sessionId, retention)
      return {
        path: targetPath,
        rootPath: join(targetPath, root.filename),
        layout: { root: root.filename, descendants, media },
        snapshotId,
      }
    } catch (error) {
      await rm(tempPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    } finally {
      inflight.delete(sessionId)
    }
  })()
  inflight.set(sessionId, task)
  return task
}
