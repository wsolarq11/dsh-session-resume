/** Host-side resume plan: one atomic decision containing source logs, target workspace, and attempt id. */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { formatMention } from '../shared/session-uri.js'
import { MAX_SOURCE_SESSIONS } from '../shared/constants.js'
import { resolveSourceLog, type SessionLogPathInfo } from './session-log.js'
import { WORKSPACE_MANIFEST_FILE, WORKSPACE_STATE_DIR } from './workspace-state.js'
import type { HostContext } from './types.js'
import { resolveResumeWorkspace } from './workspace.js'
import type { ResumePlan, ResumeSourceInfo, ResumeTarget } from '../shared/plan.js'

async function hasWorkspaceState(snapshotPath: string): Promise<boolean> {
  try {
    await access(join(snapshotPath, WORKSPACE_STATE_DIR, WORKSPACE_MANIFEST_FILE))
    return true
  } catch {
    return false
  }
}

export type { ResumePlan, ResumeSourceInfo, ResumeTarget }

/** A single source resolution that preserves the real failure status/error. */
export type ResolvedPlanSource =
  | { ok: true; source: ResumeSourceInfo }
  | { ok: false; status: number; error: string }

async function toSourceInfo(log: SessionLogPathInfo): Promise<ResumeSourceInfo> {
  return {
    sessionId: log.sessionId,
    label: log.label,
    path: log.path,
    kind: log.kind,
    cwd: log.cwd,
    rootPath: log.rootPath,
    layout: log.layout,
    mention: formatMention(log.sessionId, log.label),
    snapshotId: log.snapshotId,
    workspaceState: await hasWorkspaceState(log.path),
  }
}

/** Resolve one source session's log (from a snapshot or by materializing it). */
async function resolveOneSource(
  ctx: HostContext,
  sessionId: string,
  snapshotId: string | undefined,
): Promise<ResolvedPlanSource> {
  const log = await resolveSourceLog(ctx, sessionId, snapshotId)
  if (!log.ok) return log
  return { ok: true, source: await toSourceInfo(log) }
}

/** Resolve the target workspace from the first source with a resolvable cwd. */
async function resolveFirstWorkspace(
  ctx: HostContext,
  sources: readonly ResumeSourceInfo[],
): Promise<{ ok: true; target: ResumeTarget } | { ok: false; status: number; error: string }> {
  let firstError: { status: number; error: string } | undefined
  for (const source of sources) {
    const resolved = await resolveResumeWorkspace(ctx, source.sessionId, source.cwd)
    if (resolved.ok) return { ok: true, target: { workspaceId: resolved.workspaceId, cwd: resolved.cwd } }
    if (!firstError) firstError = { status: resolved.status, error: resolved.error }
  }
  return {
    ok: false,
    status: firstError?.status ?? 409,
    error: firstError?.error ?? '续跑的所有源会话都无法解析到原工作区',
  }
}

/**
 * Resolve a single-session resume plan. The `attemptId` is the caller's
 * idempotency key (owned by the order book + WAL), so it is required here and
 * never invented inside the resolver.
 */
export async function resolveResumePlan(
  ctx: HostContext,
  sessionId: string,
  attemptId: string,
  snapshotId?: string,
): Promise<ResumePlan> {
  return resolveResumeBatchPlan(
    ctx,
    [sessionId],
    attemptId,
    snapshotId ? { [sessionId]: snapshotId } : undefined,
  )
}

export async function resolveResumeBatchPlan(
  ctx: HostContext,
  sessionIds: readonly string[],
  attemptId: string,
  snapshotIds?: Readonly<Record<string, string>>,
): Promise<ResumePlan> {
  if (sessionIds.length === 0) {
    return { ok: false, status: 400, error: 'sessionIds 不能为空' }
  }
  if (sessionIds.length > MAX_SOURCE_SESSIONS) {
    return { ok: false, status: 400, error: `批量续跑最多支持 ${MAX_SOURCE_SESSIONS} 个会话` }
  }
  const resolved = await Promise.all(
    sessionIds.map((sessionId) => resolveOneSource(ctx, sessionId, snapshotIds?.[sessionId])),
  )
  const failed = resolved.find(
    (entry): entry is Extract<ResolvedPlanSource, { ok: false }> => !entry.ok,
  )
  if (failed) return failed
  const sources = resolved
    .filter((entry): entry is Extract<ResolvedPlanSource, { ok: true }> => entry.ok)
    .map((entry) => entry.source)
  const target = await resolveFirstWorkspace(ctx, sources)
  if (!target.ok) return target
  return { ok: true, attemptId, sources, target: target.target }
}
