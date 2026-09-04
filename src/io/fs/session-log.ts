/** Host log resolution: find the session, resolve labels/mentions, and read the raw artifact. */

import { readFile } from 'node:fs/promises'
import { materializeSessionLogExport } from './log-materialize.js'
import { formatMention } from '../../pure/refs/session-uri.js'
import { findSessionIdFromMention, findSessionSourceRefs } from '../../pure/refs/source-ref.js'
import { readResumeConfig } from './config.js'
import { listSessionSnapshots } from './snapshot-store.js'
import { hasLegacySurfaceEvents } from '../../pure/text/legacy-surface.js'
import { flushLiveSession, readCacheRootSafe, readSessionPersistence, readSessionQuery } from '../../orchestration/host/service.js'
import { JSONL_DIRECTORY_KIND, type ResumeSourceInfo } from '../../pure/plan/plan.js'
import type {
  HostContext,
  SessionPersistenceLike,
  SessionQueryLike,
  SessionRecordLike,
} from '../../contract/host-types.js'

export interface SessionInfo {
  sessionId: string
  label: string
  mention: string
}

/** Host source resolution without the client-only mention/workspace-state decorations. */
export type SessionLogPathInfo = Omit<ResumeSourceInfo, 'mention' | 'workspaceState'>

export type SessionLogPathResult =
  | ({ ok: true } & SessionLogPathInfo)
  | { ok: false; status: 404 | 500 | 501; error: string }

/**
 * Resolve one source session's log either from a historical snapshot or by
 * materializing the live log. Returns the shared `SessionLogPathInfo` shape
 * that both single and batch resume plans consume.
 */
export async function resolveSourceLog(
  ctx: HostContext,
  sessionId: string,
  snapshotId?: string,
): Promise<SessionLogPathResult> {
  if (snapshotId) {
    const snapshots = await listSessionSnapshots(ctx, sessionId)
    const match = snapshots.find((entry) => entry.snapshotId === snapshotId)
    if (!match || !match.readable) {
      return { ok: false, status: 404, error: '指定快照不存在或不可读' }
    }
    const found = await findSessionRecord(ctx, sessionId)
    // Title/cwd are only enrichment here; an unavailable query degrades to the
    // snapshot's own fields rather than failing this snapshot resolution.
    const record = found.ok ? found.record : null
    const label = record?.header.title || match.sessionId
    return {
      ok: true,
      sessionId,
      label,
      path: match.path,
      kind: JSONL_DIRECTORY_KIND,
      cwd: record?.header.cwd,
      rootPath: match.rootPath,
      layout: match.layout,
      snapshotId: match.snapshotId,
      // Read the snapshot's own root artifact (a byte-copy of the source raw)
      // so snapshot resume never re-reads the live/persisted source. This
      // keeps the "snapshot reuse does not re-materialize" contract while still
      // routing legacy sources away from the fragile mention read.
      legacySurface: match.rootPath ? await scanRootForLegacy(match.rootPath) : false,
    }
  }
  return resolveSessionLogPath(ctx, sessionId)
}

/**
 * Outcome of looking up one session by id. A `record` of `null` is an
 * authoritative "no such session" (missing), while `ok: false` means the query
 * service itself was unavailable or failed — callers must not map that to a
 * "not found" 404.
 */
export type FindSessionResult =
  | { ok: true; record: SessionRecordLike | null }
  | { ok: false; error: string }

export async function findSessionRecord(
  ctx: HostContext,
  sessionId: string,
): Promise<FindSessionResult> {
  const query = readSessionQuery(ctx)
  if (!query || typeof query.listSessions !== 'function') {
    return { ok: false, error: '会话查询服务不可用' }
  }
  try {
    const records = await query.listSessions()
    return { ok: true, record: records.find((record) => record.header?.id === sessionId) ?? null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Extract a title string from an unknown snapshot observation (either the wrapped or flat shape). */
function titleFromObservation(observation: unknown): string | null {
  if (!observation || typeof observation !== 'object') return null
  const wrapped = (observation as { value?: { title?: unknown } }).value
  const titleValue =
    wrapped && typeof wrapped === 'object' && wrapped.title !== undefined
      ? wrapped.title
      : (observation as { title?: unknown }).title
  if (typeof titleValue === 'string') return titleValue
  if (titleValue && typeof titleValue === 'object' && typeof (titleValue as { title: unknown }).title === 'string') {
    return (titleValue as { title: string }).title
  }
  return null
}

export async function readSessionTitle(
  query: SessionQueryLike | null,
  sessionId: string,
): Promise<string | null> {
  if (!query) return null
  try {
    if (typeof query.readTitleSnapshots === 'function') {
      const snapshots = await query.readTitleSnapshots([sessionId])
      return titleFromObservation(snapshots?.[0])
    }
    const title = await query.readTitle(sessionId)
    return title?.title ?? null
  } catch {
    return null
  }
}

export type { SessionLogLayout } from '../../pure/plan/plan.js'

export async function resolveSessionLogPath(
  ctx: HostContext,
  sessionId: string,
): Promise<SessionLogPathResult> {
  const found = await findSessionRecord(ctx, sessionId)
  if (!found.ok) {
    return { ok: false, status: 500, error: `无法查询会话信息: ${found.error}` }
  }
  const record = found.record
  if (!record) {
    return { ok: false, status: 404, error: '会话不存在或不可读' }
  }

  const persistence = readSessionPersistence(ctx)
  if (!persistence || persistence.supportsRawArtifacts !== true || typeof persistence.readRaw !== 'function') {
    return { ok: false, status: 501, error: '当前部署没有按会话暴露原始日志工件' }
  }

  if (record.live) {
    try {
      await flushLiveSession(ctx, sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status: 501, error: `无法确认该会话日志已完成持久化落盘: ${message}` }
    }
  }

  let raw
  try {
    raw = await persistence.readRaw(sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 501, error: `无法读取会话日志工件: ${message}` }
  }
  if (!raw) {
    return { ok: false, status: 404, error: '会话日志尚未落盘或不存在' }
  }

  const query = readSessionQuery(ctx)
  const label = (await readSessionTitle(query, sessionId)) ?? sessionId
  try {
    // The runtime may wrap HostContext in a getter-only facade that throws on
    // undeclared reads, so read the cache root through the safe helper.
    const cacheRoot = readCacheRootSafe(ctx)
    const config = await readResumeConfig(cacheRoot)
    const materialized = await materializeSessionLogExport(ctx, raw, sessionId, {
      retention: config.snapshotRetention,
      cwd: record.header.cwd,
    })
    return {
      ok: true,
      sessionId,
      label,
      path: materialized.path,
      kind: JSONL_DIRECTORY_KIND,
      cwd: record.header.cwd,
      rootPath: materialized.rootPath,
      layout: materialized.layout,
      snapshotId: materialized.snapshotId,
      legacySurface: hasLegacySurfaceEvents(raw.content),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 501, error: `无法物化会话日志目录: ${message}` }
  }
}

/**
 * Best-effort legacy-surface assessment of a snapshot's root artifact. Reading
 * the materialized file (never the live source) keeps snapshot resume from
 * re-touching the source, and a missing/unreadable snapshot root degrades to
 * `false` (treat as a normal source) rather than failing snapshot resolution —
 * the flag only changes which reference is emitted, never hard-fails a resume.
 */
async function scanRootForLegacy(rootPath: string): Promise<boolean> {
  try {
    const content = await readFile(rootPath, 'utf8')
    return hasLegacySurfaceEvents(content)
  } catch {
    return false
  }
}

export async function resolveSession(
  ctx: HostContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const found = await findSessionRecord(ctx, sessionId)
  // A query failure degrades to "cannot resolve" (callers treat null as
  // unresolvable and stop), never a fabricated session identity.
  if (!found.ok || !found.record) return null
  const record = found.record
  const query = readSessionQuery(ctx)
  const label = (await readSessionTitle(query, sessionId)) ?? sessionId
  return { sessionId, label, mention: formatMention(sessionId, label) }
}

export async function resolveFromText(
  ctx: HostContext,
  text: string,
): Promise<SessionInfo | null> {
  const sessionId =
    findSessionSourceRefs(text)[0]?.id ??
    findSessionIdFromMention(text)
  if (!sessionId) return null
  return resolveSession(ctx, sessionId)
}

export function exportDownloadPath(sessionId: string): string {
  return '/api/session.export?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=true'
}
