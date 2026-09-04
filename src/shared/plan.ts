/**
 * Shared resume-plan wire contract.
 *
 * The Host API returns one plan shape for both the single-session (`/resume`)
 * and batch (`/resume-batch`) endpoints, and the client executor consumes the
 * same shape. Keeping the contract in one shared module guarantees the two
 * sides cannot drift: an ok plan always carries an attemptId, its sources, and
 * the target workspace id (the client fails closed when the workspace id is
 * missing, so the field is required on the wire).
 */

/** The `kind` token for a materialized snapshot source on the wire. */
export const JSONL_DIRECTORY_KIND = 'jsonl-directory'

/** The on-disk layout of one materialized snapshot directory. */
export interface SessionLogLayout {
  root: string
  descendants: number
  media: number
}

/** One source session in a resume plan. */
export interface ResumeSourceInfo {
  sessionId: string
  label: string
  /** Absolute path to the materialized snapshot directory (jsonl-directory). */
  path: string
  kind: string
  cwd?: string
  /**
   * Path to the session log artifact inside the snapshot directory; absent
   * when the snapshot is degraded/unreadable (the client still lists the
   * directory as a reference).
   */
  rootPath?: string
  layout?: SessionLogLayout
  snapshotId?: string
  /** Canonical mention; when present the resume text uses it instead of `path`. */
  mention?: string
  /** Whether the snapshot packaged a workspace-state/ directory. */
  workspaceState?: boolean
  /**
   * Whether the source log carries engine-upgradable legacy message events
   * (missing message identity). Such a source must be resumed through the
   * snapshot path reference instead of an engine `dsh-session:` mention, which
   * would re-trigger the fragile surface-read validation and fail with
   * "lacks an identified message".
   */
  legacySurface?: boolean
}

/** The target workspace a resume must create/reuse a session in. */
export interface ResumeTarget {
  /** Required: the client fails closed with no target workspace id. */
  workspaceId: string
  cwd?: string
}

/** The resolved plan the client consumes; `ok: true` is guaranteed by the fetch guard. */
export interface ResumePlanOk {
  ok: true
  attemptId: string
  sources: ResumeSourceInfo[]
  target: ResumeTarget
}

export interface ResumePlanFailure {
  ok: false
  status: number
  error: string
}

export type ResumePlan = ResumePlanOk | ResumePlanFailure

/**
 * Reusable structure guard for `ResumePlan`, shared by WAL recovery and any
 * fetch/snapshot boundary so the ok/failure shape is validated in exactly one
 * place instead of being re-implemented per consumer.
 */
export function isResumePlan(value: unknown): value is ResumePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return false
  if (record.ok === true) {
    const target = record.target
    return (
      Array.isArray(record.sources) &&
      typeof target === 'object' &&
      target !== null &&
      !Array.isArray(target) &&
      typeof (target as { workspaceId?: unknown }).workspaceId === 'string'
    )
  }
  return typeof record.status === 'number' && typeof record.error === 'string'
}
