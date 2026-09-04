/**
 * Client-side single-session resume order.
 *
 * Thin wrapper over the shared resume executor: resolves the Host plan,
 * creates/reuses a session, sends the resume prompt, and reports the terminal
 * state back. The in-flight dedup keyed by source session keeps the header
 * button and the input dock from issuing duplicate orders.
 */

import { runResumeOnce, runResumeInFlight, buildSingleResumeText, type ResumeStage } from './resume-executor.js'
import type { ClientContext } from './types.js'
import type { ResumePlanOk } from '../shared/plan.js'

export function runResumeOrder(
  ctx: ClientContext,
  sessionId: string,
  onStage?: (stage: ResumeStage) => void,
): Promise<{ plan: ResumePlanOk; newId: string }> {
  return runResumeInFlight(sessionId, () =>
    runResumeOnce(ctx, {
      endpoint: '/resume',
      body: { sessionId },
      attemptIdPrefix: 'resume-',
      eventLabel: '续跑',
      onStage,
      buildText: async (plan) => buildSingleResumeText(plan),
    }),
  )
}
