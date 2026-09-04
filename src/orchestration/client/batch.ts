/**
 * Client-side batch resume order.
 *
 * Thin wrapper over the shared resume executor: materializes several source
 * sessions into one Host plan, creates/reuses one target session, and prompts
 * it with every snapshot path. The shared executor adds the same bounded
 * retry, clipboard fallback, and accepted/failed reporting the single-session
 * flow uses, so failures are never silently dropped.
 */

import { runResumeOnce, runResumeInFlight, buildBatchResumeText, type ResumeStage } from './resume-executor.js'
import type { ClientContext } from './types.js'
import type { ResumePlanOk } from '../../pure/plan/plan.js'

/**
 * Canonical in-flight key for a batch: order-insensitive so the same session
 * set cannot be resubmitted just by reordering the pasted references. Sorting
 * the copy of ids also keeps two different sets with `|`-inside ids apart.
 */
export function batchOrderKey(sessionIds: readonly string[]): string {
  return JSON.stringify([...sessionIds].sort())
}

export function runResumeBatchOrder(
  ctx: ClientContext,
  sessionIds: readonly string[],
  snapshotIds?: Readonly<Record<string, string>>,
  onStage?: (stage: ResumeStage) => void,
): Promise<{ plan: ResumePlanOk; newId: string }> {
  return runResumeInFlight(batchOrderKey(sessionIds), () =>
    runResumeOnce(ctx, {
      endpoint: '/resume-batch',
      body: { sessionIds },
      ...(snapshotIds ? { snapshotIds } : {}),
      attemptIdPrefix: 'resume-batch-',
      eventLabel: '批量续跑',
      onStage,
      buildText: async (plan) => buildBatchResumeText(plan),
    }),
  )
}
