/** Batch resume prompt text: lists every source (mention or path) plus the shared instruction. */

import { RESUME_INSTRUCTION } from './constants.js'
import { workspaceStateSuffix } from './resume-text.js'

export interface BatchSourceLike {
  path: string
  label?: string
  snapshotId?: string
  /** Canonical mention; when present it takes precedence over `path`. */
  mention?: string
  /** Whether the snapshot packaged a workspace-state/ directory. */
  workspaceState?: boolean
}

export function buildResumeBatchText(
  sources: readonly BatchSourceLike[],
  instruction: string = RESUME_INSTRUCTION,
): string {
  const lines = sources.map((source, index) => {
    const label = source.label ? `【${source.label}】` : ''
    const snapshot = source.snapshotId ? `（快照 ${source.snapshotId}）` : ''
    const reference = source.mention ?? source.path
    return `${index + 1}. ${label}${reference}${snapshot}`
  })
  const hasState = sources.some((source) => source.workspaceState === true)
  return `以下 ${sources.length} 个会话快照请全部读取：\n${lines.join('\n')}\n\n${instruction}${workspaceStateSuffix(hasState)}`
}
