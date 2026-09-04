/** Structured audit line for every resume order attempt. */

import type { HostContext } from '../../contract/host-types.js'

export type ResumeAuditStatus = 'resolved' | 'accepted' | 'failed'

export interface ResumeAuditEvent {
  requestId: string
  remoteAddress: string
  attemptId: string
  sourceSessionId: string
  targetWorkspaceId?: string
  targetSessionId?: string
  status: ResumeAuditStatus
  error?: string
  durationMs: number
}

export function logResumeAudit(
  logger: HostContext['logger'],
  event: ResumeAuditEvent,
): void {
  const line = JSON.stringify({ event: 'session-resume.order', ...event })
  logger?.info?.(line)
}
