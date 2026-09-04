/**
 * Order book for resume attempts: attemptId idempotency plus per-source
 * serialization of plan resolution.
 *
 * The plan Promise of a repeated attemptId is shared, so concurrent callers
 * resolve the target once. Per-source serialization chains plans of the same
 * source session (each run waits for the previous run's settlement); the
 * chain map holds only in-flight sources because every settled tail prunes
 * itself. Optional WAL persistence (see order-wal.ts) lets a restarted Host
 * recover terminal attempt states so `/complete` stays idempotent across
 * restarts.
 */

import type { ResumePlan } from './resume-plan.js'
import type { ResumeOrderWal } from './order-wal.js'

export interface ResumeOrderLogger {
  error?(...args: unknown[]): void
}

export const MAX_ORDER_ATTEMPTS = 1024
export const SAFE_ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/

export type ResumeCompletionStatus = 'accepted' | 'failed'
export type ResumeOrderStatus = 'planned' | 'accepted' | 'failed'

export interface ResumeOrderState {
  attemptId: string
  sourceSessionId: string
  status: ResumeOrderStatus
  plan?: ResumePlan
  targetSessionId?: string
  error?: string
}

interface ResumeOrderAttempt {
  sourceSessionId: string
  plan: Promise<ResumePlan>
  state: ResumeOrderState
}

export function isSafeOrderId(value: string): boolean {
  return SAFE_ORDER_ID.test(value)
}

export class ResumeOrderBook {
  private readonly attempts = new Map<string, ResumeOrderAttempt>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly wal?: ResumeOrderWal
  private readonly maxAttempts: number
  private readonly logger?: ResumeOrderLogger
  private ready: Promise<void> = Promise.resolve()

  constructor(options: { wal?: ResumeOrderWal; maxAttempts?: number; logger?: ResumeOrderLogger } = {}) {
    this.wal = options.wal
    this.maxAttempts = options.maxAttempts ?? MAX_ORDER_ATTEMPTS
    this.logger = options.logger
  }

  /** Restore persisted attempts from the WAL (call once at startup). */
  async loadFromWal(): Promise<void> {
    const task = (async () => {
      if (!this.wal) return
      try {
        const states = await this.wal.load()
        for (const state of states.values()) {
          if (this.attempts.has(state.attemptId)) continue
          this.attempts.set(state.attemptId, {
            sourceSessionId: state.sourceSessionId,
            plan: Promise.resolve(state.plan ?? { ok: false, status: 500, error: 'WAL 中无计划' }),
            state,
          })
        }
        await this.trimAndRewrite()
      } catch (error) {
        this.logger?.error?.(
          JSON.stringify({
            event: 'session-resume.wal-load-failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    })()
    this.ready = task
    await task
  }

  private async persist(state: ResumeOrderState): Promise<void> {
    if (!this.wal) return
    try {
      await this.wal.append(state)
    } catch (error) {
      this.logger?.error?.(
        JSON.stringify({
          event: 'session-resume.wal-append-failed',
          attemptId: state.attemptId,
          status: state.status,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  run(
    sourceSessionId: string,
    attemptId: string,
    resolvePlan: () => Promise<ResumePlan>,
  ): Promise<ResumePlan> {
    return this.ready.then(() => this.runAfterReady(sourceSessionId, attemptId, resolvePlan))
  }

  private runAfterReady(
    sourceSessionId: string,
    attemptId: string,
    resolvePlan: () => Promise<ResumePlan>,
  ): Promise<ResumePlan> {
    const existing = this.attempts.get(attemptId)
    if (existing) {
      if (existing.sourceSessionId !== sourceSessionId) {
        return Promise.resolve({ ok: false, status: 409, error: 'attemptId 已绑定其他会话' })
      }
      return existing.plan
    }

    const state: ResumeOrderState = { attemptId, sourceSessionId, status: 'planned' }
    const tail = this.tails.get(sourceSessionId) ?? Promise.resolve()
    const plan = tail
      .then(resolvePlan)
      .then(async (result) => {
        state.plan = result
        if (!result.ok) {
          state.status = 'failed'
          state.error = result.error
        }
        await this.persist(state)
        return result
      })
      .catch(async (planError) => {
        // A throwing resolver is a failed plan, not a control-flow exception:
        // return it as data so every caller (and /complete) sees a settled
        // attempt instead of an unhandled rejection.
        const failed: ResumePlan = {
          ok: false,
          status: 500,
          error: planError instanceof Error ? planError.message : String(planError),
        }
        state.plan = failed
        state.status = 'failed'
        state.error = failed.error
        await this.persist(state)
        return failed
      })
    this.attempts.set(attemptId, { sourceSessionId, plan, state })
    const settledTail = plan.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(sourceSessionId, settledTail)
    void settledTail.then(() => {
      if (this.tails.get(sourceSessionId) === settledTail) this.tails.delete(sourceSessionId)
      void this.trimAndRewrite()
    })
    return plan
  }

  /**
   * Return a caller-visible copy of an attempt state so external code cannot
   * mutate the authoritative in-memory object (which is shared with the WAL
   * append path). The copy shares the immutable `plan` reference but owns its
   * own `status`/`targetSessionId`/`error`.
   */
  private snapshot(state: ResumeOrderState): ResumeOrderState {
    return { ...state }
  }

  get(attemptId: string): ResumeOrderState | undefined {
    const state = this.attempts.get(attemptId)?.state
    return state ? this.snapshot(state) : undefined
  }

  async complete(
    attemptId: string,
    targetSessionId: string | undefined,
    status: ResumeCompletionStatus,
    error?: string,
  ): Promise<ResumeOrderState | null> {
    await this.ready
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return null
    // A throwing resolver is already converted to a failed-plan result by
    // run(), so awaiting here never rejects.
    await attempt.plan
    const state = attempt.state
    if (state.status !== 'planned' || !state.plan?.ok) return this.snapshot(state)
    state.status = status
    state.targetSessionId = targetSessionId
    state.error = status === 'failed' ? error : undefined
    await this.persist(state)
    void this.trimAndRewrite()
    return this.snapshot(state)
  }

  /**
   * Drop the oldest completed attempts once the in-memory book exceeds its cap
   * and rewrite the WAL so it never grows without bound. In-flight `planned`
   * attempts are never trimmed; rewrite is best-effort and runs through the
   * same WAL queue as appends so it cannot clobber a later append.
   */
  private async trimAndRewrite(): Promise<void> {
    if (this.attempts.size <= this.maxAttempts) return
    const removable: string[] = []
    for (const [attemptId, entry] of this.attempts) {
      if (entry.state.status !== 'planned') removable.push(attemptId)
    }
    let excess = this.attempts.size - this.maxAttempts
    for (const attemptId of removable) {
      if (excess <= 0) break
      this.attempts.delete(attemptId)
      excess -= 1
    }
    if (this.attempts.size <= this.maxAttempts) return
    if (!this.wal) return
    const remaining = [...this.attempts.values()].map((entry) => entry.state)
    try {
      await this.wal.rewrite(remaining)
    } catch (error) {
      this.logger?.error?.(
        JSON.stringify({
          event: 'session-resume.wal-rewrite-failed',
          remaining: remaining.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}
