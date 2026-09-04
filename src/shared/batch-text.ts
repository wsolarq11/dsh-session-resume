/** Batch resume prompt text: lists every source (mention or path) plus the shared instruction. */

import { RESUME_INSTRUCTION } from './constants.js'
import { workspaceStateSuffix } from './resume-text.js'

export interface BatchSourceLike {
  path: string
  label?: string
  snapshotId?: string
  /** Canonical mention; when present it takes precedence over `path`. */
  mention?: string
  /** Legacy sources must use the path reference, not the mention. */
  legacySurface?: boolean
  /** The session-log artifact file inside the snapshot; preferred for legacy routing. */
  rootPath?: string
  /** Whether the snapshot packaged a workspace-state/ directory. */
  workspaceState?: boolean
}

/**
 * The reference text for one source: the mention for healthy sources, the
 * session-log artifact path for legacy ones (so the new session recognizes a
 * `session.jsonl` file, never an engine `dsh-session:` mention that would
 * re-trigger the fragile surface read).
 */
function sourceReference(source: BatchSourceLike): string {
  return source.legacySurface === true ? source.rootPath ?? source.path : source.mention ?? source.path
}

export function buildResumeBatchText(
  sources: readonly BatchSourceLike[],
  instruction: string = RESUME_INSTRUCTION,
): string {
  const lines = sources.map((source, index) => {
    const label = source.label ? `【${source.label}】` : ''
    const snapshot = source.snapshotId ? `（快照 ${source.snapshotId}）` : ''
    const reference = sourceReference(source)
    return `${index + 1}. ${label}${reference}${snapshot}`
  })
  const hasState = sources.some((source) => source.workspaceState === true)
  return `以下 ${sources.length} 个会话快照请全部读取：\n${lines.join('\n')}\n\n${instruction}${workspaceStateSuffix(hasState)}`
}
