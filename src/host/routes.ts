/**
 * Resume API route handlers and the request helpers they share.
 *
 * Kept out of `api.ts` (the dispatch/transport shell) so the route business
 * logic — the JSON read helpers, the safe-token/session validators, the shared
 * plan-order runner, and the nine handler bodies — never pushes the HTTP file
 * toward the module-size boundary again. Adding a new route means adding one
 * entry here, not growing the dispatcher.
 */

import { randomUUID } from 'node:crypto'
import { logResumeAudit } from './audit.js'
import {
  normalizeResumeConfig,
  readResumeConfig,
  writeResumeConfig,
} from './config.js'
import { ResumeOrderBook, isSafeOrderId } from './resume-order.js'
import { resolveResumePlan, resolveResumeBatchPlan, type ResumePlan } from './resume-plan.js'
import {
  exportDownloadPath,
  resolveFromText,
  resolveSession,
  resolveSessionLogPath,
} from './session-log.js'
import { listSessionSnapshots } from './snapshot-store.js'
import { readCacheRootSafe } from './service.js'
import type { HostContext, HttpRequestLike, HttpResponseLike } from './types.js'

const MAX_BODY_BYTES = 64 * 1024
const TOKEN_INVALID_ERROR = '只能包含字母、数字、下划线或连字符，且不超过 128 字符'

/** The runtime services a route may touch. */
export interface ApiRouteContext {
  orders: ResumeOrderBook
  ctx: HostContext
}

/** Signature every route handler implements, driven by the dispatch shell. */
export type ApiRouteHandler = (
  deps: ApiRouteContext,
  req: HttpRequestLike,
  res: HttpResponseLike,
  requestId: string,
  remote: string,
  url: URL,
) => Promise<void>

export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  handler: ApiRouteHandler
}

/** Write a JSON response with the request-id envelope and optional retry-after. */
export function send(
  res: HttpResponseLike,
  code: number,
  payload: object,
  requestId: string,
  retryAfterMs?: number,
): void {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(retryAfterMs / 1000))
  res.writeHead(code, headers)
  res.end(JSON.stringify({ requestId, ...payload }))
}

function readBody(req: HttpRequestLike): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: unknown) => {
      body +=
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : String(chunk)
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        req.removeAllListeners?.('data')
        req.removeAllListeners?.('end')
        reject(new Error('request body too large'))
        req.resume?.()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * Read and parse a JSON-object request body. Returns `null` after sending a
 * 400 response when the body is unreadable, oversized, or not a JSON object.
 */
async function readJsonBody(
  req: HttpRequestLike,
  res: HttpResponseLike,
  requestId: string,
): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (error) {
    send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, requestId)
    return null
  }
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    send(res, 400, { ok: false, error: '请求体不是有效 JSON' }, requestId)
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    send(res, 400, { ok: false, error: '请求体不是有效 JSON 对象' }, requestId)
    return null
  }
  return parsed as Record<string, unknown>
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Validate an optional bounded token field (attemptId / snapshotId) through
 * one shared guard. A missing or non-string value is silently absent; a
 * non-empty string that fails the safe-id rule is a client error.
 */
function readOptionalToken(
  value: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const text = readOptionalString(value)
  if (text === undefined) return { ok: true, value: undefined }
  if (!isSafeOrderId(text)) return { ok: false, error: TOKEN_INVALID_ERROR }
  return { ok: true, value: text }
}

/**
 * Validate a required bounded token field. Unlike `readOptionalToken`, the value
 * must be a present, safe non-empty string; a missing value is a client error.
 * The field name is embedded in the error so callers surface a concrete message
 * without re-wrapping ("attemptId 必填", not a bare generic string).
 */
function readRequiredToken(
  value: unknown,
  fieldName = '该字段',
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value) {
    return { ok: false, error: `${fieldName} 必填` }
  }
  if (!isSafeOrderId(value)) return { ok: false, error: `${fieldName} ${TOKEN_INVALID_ERROR}` }
  return { ok: true, value }
}

/** Parse `sessionIds` strictly: non-empty strings, no duplicates, at least one entry. */
function readSessionIds(
  value: unknown,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'sessionIds 必填且至少一个' }
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !item) {
      return { ok: false, error: 'sessionIds 必须是非空字符串数组' }
    }
    if (seen.has(item)) {
      return { ok: false, error: `sessionIds 包含重复会话: ${item}` }
    }
    seen.add(item)
    ids.push(item)
  }
  return { ok: true, ids }
}

/**
 * Parse the `snapshotIds` request field into an id -> snapshotId map. The
 * keys must be a subset of the requested `sessionIds`; an unknown key is a
 * client error (fail-closed). Each value is validated by the shared token
 * guard, so the safe-id rule stays single-sourced.
 */
function readSnapshotIds(
  value: unknown,
  sessionIds: readonly string[],
): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, map: {} }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'snapshotIds 必须是对象' }
  }
  const record = value as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string' || !item) {
      return { ok: false, error: `snapshotIds 的值必须是非空字符串: ${key}` }
    }
    // The value is a non-empty string; the shared required-token guard rejects
    // an unsafe one, so the safe-id rule stays single-sourced (no re-implemented
    // guard) without the dead optionality of `readOptionalToken`.
    const token = readRequiredToken(item, 'snapshotId')
    if (!token.ok) {
      return { ok: false, error: `${token.error}: ${key}` }
    }
    if (!sessionIds.includes(key)) {
      return { ok: false, error: `snapshotIds 包含未知会话: ${key}` }
    }
    out[key] = item
  }
  return { ok: true, map: out }
}

/** One plan-resolving order (single or batch), sharing body/audit/send handling. */
interface PlanOrderSpec {
  sourceSessionId: string
  attemptId?: string
  resolvePlan: (attemptId: string) => Promise<ResumePlan>
}

async function runPlanOrder(
  deps: ApiRouteContext,
  res: HttpResponseLike,
  requestId: string,
  remote: string,
  spec: PlanOrderSpec,
): Promise<void> {
  const attemptId = spec.attemptId ?? randomUUID()
  const startedAt = Date.now()
  const plan = await deps.orders.run(spec.sourceSessionId, attemptId, () => spec.resolvePlan(attemptId))
  const audit = {
    requestId,
    remoteAddress: remote,
    attemptId,
    sourceSessionId: spec.sourceSessionId,
    durationMs: Date.now() - startedAt,
  }
  if (!plan.ok) {
    logResumeAudit(deps.ctx.logger, { ...audit, status: 'failed', error: plan.error })
    return send(res, plan.status, plan, requestId)
  }
  logResumeAudit(deps.ctx.logger, { ...audit, status: 'resolved', targetWorkspaceId: plan.target.workspaceId })
  return send(res, 200, plan, requestId)
}

/** Build the route table: one entry per endpoint, dispatched by `api.ts`. */
export function resumeApiRoutes(deps: ApiRouteContext): ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/resume',
      handler: async ({ ctx: depCtx }, req, res, requestId, remote) => {
        const body = await readJsonBody(req, res, requestId)
        if (!body) return
        if (typeof body.sessionId !== 'string' || !body.sessionId) {
          return send(res, 400, { ok: false, error: 'sessionId 必填且必须是字符串' }, requestId)
        }
        const sessionId = body.sessionId
        const attemptToken = readOptionalToken(body.attemptId)
        if (!attemptToken.ok) {
          return send(res, 400, { ok: false, error: `attemptId ${attemptToken.error}` }, requestId)
        }
        const snapshotToken = readOptionalToken(body.snapshotId)
        if (!snapshotToken.ok) {
          return send(res, 400, { ok: false, error: `snapshotId ${snapshotToken.error}` }, requestId)
        }
        return runPlanOrder(deps, res, requestId, remote, {
          sourceSessionId: sessionId,
          attemptId: attemptToken.value,
          resolvePlan: (id) => resolveResumePlan(depCtx, sessionId, id, snapshotToken.value),
        })
      },
    },
    {
      method: 'POST',
      path: '/resume-batch',
      handler: async ({ ctx: depCtx }, req, res, requestId, remote) => {
        const body = await readJsonBody(req, res, requestId)
        if (!body) return
        const parsedSessionIds = readSessionIds(body.sessionIds)
        if (!parsedSessionIds.ok) {
          return send(res, 400, { ok: false, error: parsedSessionIds.error }, requestId)
        }
        const sessionIds = parsedSessionIds.ids
        const attemptToken = readOptionalToken(body.attemptId)
        if (!attemptToken.ok) {
          return send(res, 400, { ok: false, error: `attemptId ${attemptToken.error}` }, requestId)
        }
        const snapshotIds = readSnapshotIds(body.snapshotIds, sessionIds)
        if (!snapshotIds.ok) {
          return send(res, 400, { ok: false, error: snapshotIds.error }, requestId)
        }
        const primarySessionId = sessionIds[0]
        return runPlanOrder(deps, res, requestId, remote, {
          sourceSessionId: primarySessionId,
          attemptId: attemptToken.value,
          resolvePlan: (id) => resolveResumeBatchPlan(depCtx, sessionIds, id, snapshotIds.map),
        })
      },
    },
    {
      method: 'POST',
      path: '/complete',
      handler: async ({ ctx: depCtx }, req, res, requestId, remote) => {
        const body = await readJsonBody(req, res, requestId)
        if (!body) return
        // attemptId is mandatory here (unlike /resume); the required reader
        // carries the presence rule and safe-id rule in one place.
        const attemptToken = readRequiredToken(body.attemptId, 'attemptId')
        if (!attemptToken.ok) {
          return send(res, 400, { ok: false, error: attemptToken.error }, requestId)
        }
        const attemptId = attemptToken.value
        const status = body.status === 'accepted' ? 'accepted' : body.status === 'failed' ? 'failed' : undefined
        if (!status) return send(res, 400, { ok: false, error: 'status 必须是 accepted 或 failed' }, requestId)
        const targetSessionId = readOptionalString(body.targetSessionId)
        if (status === 'accepted' && !targetSessionId) {
          return send(res, 400, { ok: false, error: 'accepted 状态必须包含 targetSessionId' }, requestId)
        }
        const error = typeof body.error === 'string' ? body.error.slice(0, 1024) : undefined
        const startedAt = Date.now()
        const state = await deps.orders.complete(attemptId, targetSessionId, status, error)
        if (!state) return send(res, 404, { ok: false, error: 'attempt 不存在，Host 重启后内存订单已失效' }, requestId)
        if (state.status !== 'planned' && state.status !== status) {
          return send(res, 409, { ok: false, error: `attempt 已处于 ${state.status} 终态` }, requestId)
        }
        const targetWorkspaceId =
          state.plan && state.plan.ok ? state.plan.target.workspaceId : undefined
        logResumeAudit(depCtx.logger, {
          requestId,
          remoteAddress: remote,
          attemptId,
          sourceSessionId: state.sourceSessionId,
          targetWorkspaceId,
          targetSessionId: state.targetSessionId,
          status: state.status === 'planned' ? 'resolved' : state.status,
          error: state.error,
          durationMs: Date.now() - startedAt,
        })
        return send(
          res,
          200,
          {
            ok: true,
            attemptId,
            status: state.status,
            targetSessionId: state.targetSessionId,
            error: state.error,
          },
          requestId,
        )
      },
    },
    {
      method: 'GET',
      path: '/path',
      handler: async ({ ctx: depCtx }, req, res, requestId, _remote, url) => {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) return send(res, 400, { ok: false, error: 'sessionId 必填' }, requestId)
        const result = await resolveSessionLogPath(depCtx, sessionId)
        return send(res, result.ok ? 200 : result.status, result, requestId)
      },
    },
    {
      method: 'GET',
      path: '/copy',
      handler: async ({ ctx: depCtx }, req, res, requestId, _remote, url) => {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) return send(res, 400, { ok: false, error: 'sessionId 必填' }, requestId)
        const info = await resolveSession(depCtx, sessionId)
        if (!info) return send(res, 404, { ok: false, error: '会话不存在或不可读' }, requestId)
        return send(res, 200, { ok: true, ...info, downloadPath: exportDownloadPath(info.sessionId) }, requestId)
      },
    },
    {
      method: 'POST',
      path: '/resolve',
      handler: async ({ ctx: depCtx }, req, res, requestId) => {
        const body = await readJsonBody(req, res, requestId)
        if (!body) return
        const text = String(body.text ?? '')
        const info = await resolveFromText(depCtx, text.trim())
        if (!info) return send(res, 404, { ok: false, error: '无法识别会话日志链接，或会话不存在' }, requestId)
        return send(res, 200, { ok: true, ...info, downloadPath: exportDownloadPath(info.sessionId) }, requestId)
      },
    },
    {
      method: 'GET',
      path: '/snapshots',
      handler: async ({ ctx: depCtx }, req, res, requestId, _remote, url) => {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) return send(res, 400, { ok: false, error: 'sessionId 必填' }, requestId)
        const snapshots = await listSessionSnapshots(depCtx, sessionId)
        return send(res, 200, { ok: true, sessionId, snapshots }, requestId)
      },
    },
    {
      method: 'GET',
      path: '/config',
      handler: async ({ ctx: depCtx }, req, res, requestId) => {
        const config = await readResumeConfig(readCacheRootSafe(depCtx))
        depCtx.logger?.info?.(
          JSON.stringify({ event: 'session-resume.config-read', requestId }),
        )
        return send(res, 200, { ok: true, config }, requestId)
      },
    },
    {
      method: 'PUT',
      path: '/config',
      handler: async ({ ctx: depCtx }, req, res, requestId) => {
        const body = await readJsonBody(req, res, requestId)
        if (!body) return
        const config = normalizeResumeConfig(body)
        const saved = await writeResumeConfig(config, readCacheRootSafe(depCtx))
        depCtx.logger?.info?.(
          JSON.stringify({ event: 'session-resume.config-updated', requestId }),
        )
        return send(res, 200, { ok: true, config: saved }, requestId)
      },
    },
  ]
}