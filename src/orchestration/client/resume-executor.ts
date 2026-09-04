/**
 * Shared client-side resume executor.
 *
 * Single-session (`/resume`) and batch (`/resume-batch`) orders share one
 * flow: resolve the Host plan -> build the resume text -> create/reuse the
 * target session -> prompt it with bounded retries -> report the terminal
 * state back to the Host. The header button, the input dock, and the batch
 * button all drive this executor, so retry, clipboard fallback, reporting,
 * and in-flight dedup behave identically everywhere.
 */

import { connectResumeSession, promptResumeSession, resolveResumeInstruction, buildResumePromptWithInstruction } from './resume-client.js'
import { buildResumeBatchText } from '../../pure/text/batch-text.js'
import type { ResumePlanOk } from '../../pure/plan/plan.js'
import type { ResumeSessionsClient } from './resume-client.js'
import type { ClientContext } from './types.js'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

const ORDER_RETRY_LIMIT = 3
const ORDER_RETRY_BASE_MS = 500

/** Exponential back-off for a single retry step (attempt-indexed). */
function retryDelayMs(attempt: number): number {
  return ORDER_RETRY_BASE_MS * 2 ** attempt
}

/**
 * Run a bounded attempt loop with exponential back-off until `isDone` says
 * the outcome is final. Every bounded retry in the client uses this one
 * strategy so retry/backoff semantics stay single-sourced.
 */
async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  isDone: (outcome: T) => boolean,
): Promise<T> {
  let last: T | undefined
  for (let index = 0; index < ORDER_RETRY_LIMIT; index += 1) {
    last = await attempt()
    if (isDone(last)) return last
    if (index < ORDER_RETRY_LIMIT - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(index)))
    }
  }
  return last as T
}

export type ResumeStage = 'resolving' | 'creating' | 'sending'

/**
 * The single order-state union shared by every resume UI entry point. It is the
 * `ResumeStage` plus the terminal `done` / `error` outcomes that a UI surfaces;
 * the dock and header button bind their `useState` and `useTransient` to exactly
 * this type instead of a bare `string`.
 */
export type ResumeOrderUiState = 'idle' | ResumeStage | 'done' | 'error'

export interface ResumeExecutionPlan {
  /** Per-flow text builder; runs after the plan resolves. */
  buildText: (plan: ResumePlanOk) => Promise<string>
  /** Endpoint and body distinguish single vs batch. */
  endpoint: '/resume' | '/resume-batch'
  body: Record<string, unknown>
  onStage?: (stage: ResumeStage) => void
  eventLabel: string
  /** AttemptId prefix for logs; single uses `resume-`, batch `resume-batch-`. */
  attemptIdPrefix: string
}

export interface ResumeExecutionResult {
  plan: ResumePlanOk
  /** The created/reused target session id. */
  newId: string
}

/**
 * Per-executor state that used to be bare module singletons (the in-flight dedup
 * map and the monotonic attempt-id counter). Constructing one explicit scope
 * gives each Host context its own deterministic id sequence and in-flight dedup,
 * so tests can inject a stub attempt-id source instead of depending on module
 * global state. The default scope keeps the original single-instance behavior.
 */
export interface ResumeExecutorScope {
  inFlight: Map<string, Promise<ResumeExecutionResult>>
  attemptId: (prefix: string) => string
}

/** Build a fresh executor scope with its own monotonic attempt-id counter. */
export function createResumeExecutorScope(): ResumeExecutorScope {
  let attemptSeq = 0
  return {
    inFlight: new Map<string, Promise<ResumeExecutionResult>>(),
    attemptId(prefix: string): string {
      // Prefers the platform UUID; the fallback appends a per-scope monotonic
      // counter so same-millisecond calls stay strictly increasing (business
      // ordering must never rely on the system clock alone).
      if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
      }
      attemptSeq += 1
      return `${prefix}${Date.now()}-${attemptSeq}`
    },
  }
}

/** The default single-instance scope (module-level, matching prior behavior). */
const defaultScope = createResumeExecutorScope()

/** Share one in-flight resume order by canonical key within a scope. */
export function runResumeInFlight(
  key: string,
  create: () => Promise<ResumeExecutionResult>,
  scope: ResumeExecutorScope = defaultScope,
): Promise<ResumeExecutionResult> {
  const existing = scope.inFlight.get(key)
  if (existing) return existing
  const order = create()
  scope.inFlight.set(key, order)
  const clear = () => {
    if (scope.inFlight.get(key) === order) scope.inFlight.delete(key)
  }
  order.then(clear, clear)
  return order
}

/**
 * Prompt the resume session once, with a bounded per-step retry. Resolve and
 * session creation are not retried after a connection exists, so a transient
 * prompt failure cannot spawn duplicate target sessions.
 */
async function promptResumeSessionWithRetry(
  client: ResumeSessionsClient | undefined,
  newId: string,
  text: string,
): Promise<{ accepted: boolean; error?: string }> {
  return retryWithBackoff(
    () => promptResumeSession(client, newId, text),
    (outcome) => outcome.accepted,
  )
}

function unwrapRemote<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/**
 * Resolve the mounted sessionResume remote facade.
 *
 * The host @Remote namespace is installed as a cordis runtime service keyed
 * `remote.sessionResume`. Reading the bare `remote.sessionResume` property can
 * trip the "without inject" guard, so this resolves through the runtime service
 * store first and falls back to the direct property read.
 */
export function remoteFacade(ctx: ClientContext): TypertRemoteNamespaceMap['sessionResume'] | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (get) {
    try {
      const viaService = get('remote.sessionResume')
      if (viaService) return viaService as TypertRemoteNamespaceMap['sessionResume']
    } catch {
      // fall through to the property read
    }
  }
  const remote = ctx.remote
  if (!remote) return undefined
  return remote.sessionResume
}

async function reportResumeComplete(
  ctx: ClientContext,
  attemptId: string,
  targetSessionId: string | undefined,
  status: 'accepted' | 'failed',
  error?: string,
): Promise<void> {
  const federate = remoteFacade(ctx)
  if (!federate) throw new Error('续跑远程服务不可用（remote 未挂载）')
  await unwrapRemote(await federate.completeResume(attemptId, status, targetSessionId ?? '', error ?? ''))
}


/**
 * Confirm the terminal state with the Host, retrying the SAME attemptId a
 * bounded number of times. This is the required step for an accepted order: we
 * never return success while the Host may still hold the attempt as `planned`.
 */
async function reportResumeCompleteWithRetry(
  ctx: ClientContext,
  attemptId: string,
  targetSessionId: string | undefined,
  status: 'accepted' | 'failed',
  error?: string,
): Promise<void> {
  const outcome = await retryWithBackoff(
    async () => {
      try {
        await reportResumeComplete(ctx, attemptId, targetSessionId, status, error)
        return { done: true } as const
      } catch (reportError) {
        return { done: false, reportError } as const
      }
    },
    (result) => result.done,
  )
  if (!outcome.done) {
    const message = outcome.reportError instanceof Error ? outcome.reportError.message : String(outcome.reportError)
    throw new Error(`Host 未能确认续跑完成（已重试 ${ORDER_RETRY_LIMIT} 次）: ${message}`)
  }
}

/** Best-effort failed report: a secondary notification must not mask the real error. */
async function reportResumeCompleteBestEffort(
  ctx: ClientContext,
  attemptId: string,
  targetSessionId: string | undefined,
  status: 'accepted' | 'failed',
  error: string | undefined,
): Promise<void> {
  try {
    await reportResumeComplete(ctx, attemptId, targetSessionId, status, error)
  } catch (reportError) {
    console.error(
      '[session-resume] complete report failed',
      JSON.stringify({ attemptId, targetSessionId, status, error: String(reportError) }),
    )
  }
}

/**
 * Run one resume order (single or batch).
 *
 * The Host plan is resolved once and the target session is connected once.
 * Only the prompt is retried against the same session id, so a transient send
 * failure cannot create a second target session. On final failure the resume
 * text is copied to the clipboard and the terminal `failed` state is reported
 * to the Host.
 */
export async function runResumeOnce(
  ctx: ClientContext,
  execution: ResumeExecutionPlan,
  scope: ResumeExecutorScope = defaultScope,
): Promise<ResumeExecutionResult> {
  const attemptId = scope.attemptId(execution.attemptIdPrefix)
  let newId: string | undefined
  try {
    execution.onStage?.('resolving')
    let plan: ResumePlanOk | undefined
    const remote = remoteFacade(ctx)
    if (!remote) throw new Error('续跑远程服务不可用（remote 未挂载）')
    const body = execution.body as {
      sessionId?: string; snapshotId?: string; snapshotIds?: Record<string, string>; sessionIds?: string[]
    }
    if (execution.endpoint === '/resume-batch') {
      const batchResolved = unwrapRemote(
        await remote.resolveBatchPlan(body.sessionIds ?? [], attemptId, body.snapshotIds ?? {}),
      )
      if (!batchResolved.ok) throw new Error(batchResolved.error)
      plan = batchResolved
    } else {
      const singleResolved = unwrapRemote(
        await remote.resolvePlan(body.sessionId ?? '', attemptId, body.snapshotId ?? ''),
      )
      if (!singleResolved.ok) throw new Error(singleResolved.error)
      plan = singleResolved
    }
    const text = await execution.buildText(plan)
    execution.onStage?.('creating')
    newId = await connectResumeSession(ctx.sessions, plan.target, ctx.workspaces)
    execution.onStage?.('sending')
    const prompted = await promptResumeSessionWithRetry(ctx.sessions, newId, text)
    if (!prompted.accepted) {
      const sendError = prompted.error ?? '未知错误'
      const copied = await copyText(text)
      throw new Error(
        copied
          ? `新会话已创建，但${execution.eventLabel}发送失败；续跑指令已复制到剪贴板: ${sendError}`
          : `新会话已创建，但${execution.eventLabel}发送失败，且剪贴板复制失败: ${sendError}`,
      )
    }
    await reportResumeCompleteWithRetry(ctx, attemptId, newId, 'accepted', undefined)
    return { plan, newId }
  } catch (stepError) {
    await reportResumeCompleteBestEffort(
      ctx,
      attemptId,
      newId,
      'failed',
      stepError instanceof Error ? stepError.message : String(stepError),
    )
    if (stepError instanceof Error) throw stepError
    throw new Error(String(stepError))
  }
}

/**
 * Default text builders for the two flows. Kept here so both entry points
 * share one instruction-resolution path; a canonical mention is preferred
 * over the raw snapshot path when the plan carries one.
 */
export function buildSingleResumeText(plan: ResumePlanOk): Promise<string> {
  const source = plan.sources[0]
  if (!source) return resolveResumeInstruction()
  // A legacy source (missing message identity) must resume through the snapshot
  // path, not the engine `dsh-session:` mention: the mention re-triggers the
  // fragile surface read that rejects legacy events with "lacks an identified
  // message". Path routing is the durable, reinstall-proof root fix.
  const reference =
    source.legacySurface === true ? source.rootPath ?? source.path : source.mention ?? source.path
  return buildResumePromptWithInstruction(reference, {
    workspaceState: source.workspaceState === true,
  })
}

export function buildBatchResumeText(plan: ResumePlanOk): Promise<string> {
  return resolveResumeInstruction().then((instruction) => buildResumeBatchText(plan.sources, instruction))
}

export function copyText(text: string): Promise<boolean> {
  const nav = globalThis.navigator
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    return nav.clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text),
    )
  }
  return Promise.resolve(legacyCopy(text))
}

function legacyCopy(text: string): boolean {
  const doc = globalThis.document
  if (!doc) return false
  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  doc.body.appendChild(textarea)
  textarea.select()
  let ok = false
  try {
    ok = doc.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  return ok
}


