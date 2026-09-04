/**
 * Snapshot store: the single owner of the on-disk snapshot layout.
 *
 * Every place that touches `%TEMP%\dsh-session-resume\<sessionId>\snapshots\`
 * (materialization, listing, resolution, pruning) goes through this module so
 * the cache root, safe path segments, sequence-numbered directory names, and
 * the legacy-directory tolerance stay in one place.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readCacheRootSafe, type CacheRootFacadeLike } from '../../orchestration/host/service.js'

export interface SnapshotLayoutStats {
  root: string
  descendants: number
  media: number
}

export interface StoredSnapshot {
  sessionId: string
  snapshotId: string
  path: string
  /** Root artifact path; absent when the snapshot is unreadable/degraded. */
  rootPath?: string
  createdAt: number
  layout: SnapshotLayoutStats
  /** False when the snapshot directory or root artifact is not readable. */
  readable: boolean
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
const MAX_SAFE_SEGMENT_LENGTH = 200

/**
 * Map an arbitrary session/attachment id to one safe path segment.
 *
 * Fully safe ids stay readable. Unsafe ids get a sanitized prefix plus a
 * SHA-256 digest of the full value; the `~` marker cannot appear in the safe
 * pass-through alphabet, so the two encodings cannot collide.
 */
export function safePathSegment(value: string): string {
  if (value && value.length <= MAX_SAFE_SEGMENT_LENGTH && SAFE_PATH_SEGMENT.test(value)) {
    return value
  }
  const sanitized =
    value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'x'
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
  return `~${sanitized.slice(0, 80)}_${digest}`
}

/** The per-session snapshot parent `<cacheRoot>/<safeId>/snapshots`. */
export function snapshotRootPath(cacheRoot: string, sessionId: string): string {
  return join(cacheRoot, safePathSegment(sessionId), 'snapshots')
}

/** The sequence-numbered snapshot directory for one materialization. */
export function snapshotDirectoryPath(
  cacheRoot: string,
  sessionId: string,
  snapshotId: string | number,
): string {
  return join(snapshotRootPath(cacheRoot, sessionId), String(snapshotId))
}

/**
 * Next snapshot sequence for a session, derived from stored snapshot names.
 * Business ordering and ids never depend on the system clock.
 */
export async function nextSnapshotSequence(
  cacheRoot: string,
  sessionId: string,
): Promise<string> {
  const root = snapshotRootPath(cacheRoot, sessionId)
  let max = 0
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return '1'
  }
  for (const name of names) {
    const value = Number(name)
    if (Number.isSafeInteger(value) && value > max) max = value
  }
  return String(max + 1)
}

const SESSION_LOG_FILE = /^session\.jsonl(?:\.zstd)?$/

/** Count stored subagent logs (`subagents/<safeId>/session.jsonl[.zstd]`). */
async function countDescendantLogs(subagentsDir: string): Promise<number> {
  try {
    const entries = await readdir(subagentsDir, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && SESSION_LOG_FILE.test(entry.name)).length
  } catch {
    // Missing/unreadable subagents degrade to zero descendants.
    return 0
  }
}

/**
 * Read the real layout of one snapshot directory: the root artifact filename
 * (session.jsonl[.zstd]) and the number of stored subagent logs / media
 * files. A missing or unreadable snapshot is marked unreadable rather than
 * being returned as a valid plan target.
 */
function emptySnapshotLayout(dir: string): {
  rootPath?: string
  layout: SnapshotLayoutStats
  readable: false
} {
  return { layout: { root: '', descendants: 0, media: 0 }, readable: false }
}

async function readSnapshotLayout(
  dir: string,
): Promise<{ rootPath?: string; layout: SnapshotLayoutStats; readable: boolean }> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return emptySnapshotLayout(dir)
  }
  const rootFile = names.find((name) => SESSION_LOG_FILE.test(name))
  if (!rootFile) return emptySnapshotLayout(dir)
  let rootInfo
  try {
    rootInfo = await stat(join(dir, rootFile))
  } catch {
    return emptySnapshotLayout(dir)
  }
  if (!rootInfo.isFile() || rootInfo.size === 0) return emptySnapshotLayout(dir)
  let descendants = 0
  let media = 0
  try {
    descendants = await countDescendantLogs(join(dir, 'subagents'))
  } catch {
    descendants = 0
  }
  try {
    media = (await readdir(join(dir, 'media'))).length
  } catch {
    media = 0
  }
  return {
    rootPath: join(dir, rootFile),
    layout: { root: rootFile, descendants, media },
    readable: true,
  }
}

/** Sort snapshot directory names by stored sequence, then lexically for non-numeric legacy names. */
function sortSnapshotNames(names: string[]): string[] {
  return names.sort((left, right) => {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
      return leftNumber - rightNumber
    }
    if (Number.isSafeInteger(leftNumber)) return -1
    if (Number.isSafeInteger(rightNumber)) return 1
    return left.localeCompare(right)
  })
}

/**
 * Enumerate snapshot directories from oldest to newest. Unreadable or
 * non-directory entries are skipped; a missing session root yields an empty
 * list.
 */
export async function listSnapshots(
  cacheRoot: string,
  sessionId: string,
): Promise<StoredSnapshot[]> {
  const root = snapshotRootPath(cacheRoot, sessionId)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const entries: StoredSnapshot[] = []
  for (const name of sortSnapshotNames(names)) {
    const path = join(root, name)
    try {
      if (!(await stat(path)).isDirectory()) continue
    } catch {
      continue
    }
    const { rootPath, layout, readable } = await readSnapshotLayout(path)
    let createdAt = 0
    try {
      createdAt = (await stat(path)).mtimeMs
    } catch {
      createdAt = 0
    }
    entries.push({
      sessionId,
      snapshotId: name,
      path,
      rootPath,
      createdAt,
      layout,
      readable,
    })
  }
  return entries
}

/** List historical snapshots for a session through a runtime context. */
export async function listSessionSnapshots(
  ctx: CacheRootFacadeLike,
  sessionId: string,
): Promise<StoredSnapshot[]> {
  return listSnapshots(readCacheRootSafe(ctx), sessionId)
}

/**
 * Prune the oldest snapshots so at most `retention` remain. Best-effort:
 * removal failures never fail the materialization that triggered the prune.
 */
export async function pruneSnapshots(
  cacheRoot: string,
  sessionId: string,
  retention: number,
): Promise<void> {
  const root = snapshotRootPath(cacheRoot, sessionId)
  if (retention < 0) return
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  names = sortSnapshotNames(names)
  const overflow = names.length - retention
  if (overflow <= 0) return
  for (const name of names.slice(0, overflow)) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Create the cache root directory (used before writing a temp snapshot). */
export async function ensureCacheRoot(cacheRoot: string): Promise<void> {
  await mkdir(cacheRoot, { recursive: true })
}
