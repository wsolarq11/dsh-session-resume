/**
 * HTTP surface for resume orders: loopback-only, rate-limited, request-traced.
 *
 * This module is the dispatch/transport shell. The request logic (body
 * parsing, token/session validation, the per-endpoint handlers, plan-order
 * orchestration) lives in `routes.ts`; adding or changing an endpoint happens
 * there, not here.
 */

import { randomUUID } from 'node:crypto'
import { SlidingWindowRateLimiter } from './rate-limit.js'
import { FileResumeOrderWal } from './order-wal.js'
import { readCacheRootSafe } from './service.js'
import { ResumeOrderBook } from './resume-order.js'
import { resumeApiRoutes, send, type ApiRouteContext } from './routes.js'
import type { HostContext, HttpRequestLike, HttpResponseLike } from './types.js'

const API_PREFIX = '/session-resume/api'

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

function requestIdOf(req: HttpRequestLike): string {
  const header = req.headers?.['x-request-id']
  const raw = Array.isArray(header) ? header[0] : header
  return typeof raw === 'string' && raw ? raw : randomUUID()
}

export function registerResumeApi(ctx: HostContext): () => void {
  if (!ctx.webServer) {
    ctx.logger?.warn?.('[session-resume] webServer unavailable; resume API not registered')
    return () => undefined
  }
  const limiter = new SlidingWindowRateLimiter(20, 60_000)
  const orders = new ResumeOrderBook({ wal: new FileResumeOrderWal(readCacheRootSafe(ctx)), logger: ctx.logger })
  void orders.loadFromWal()

  const deps: ApiRouteContext = { orders, ctx }
  const routes = resumeApiRoutes(deps)

  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: HttpRequestLike, res: HttpResponseLike) => {
      const requestId = requestIdOf(req)
      const remote = req.socket?.remoteAddress ?? 'local'
      if (!isLoopbackAddress(remote)) {
        return send(res, 403, { ok: false, error: '仅允许本机访问' }, requestId)
      }
      const rate = limiter.check(remote)
      if (!rate.allowed) {
        return send(
          res,
          429,
          { ok: false, error: '续跑请求过于频繁，请稍后再试', retryAfterMs: rate.retryAfterMs },
          requestId,
          rate.retryAfterMs,
        )
      }

      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const path = url.pathname.replace(API_PREFIX, '') || '/'
        const route = routes.find(
          (candidate) => candidate.method === req.method && candidate.path === path,
        )
        if (!route) return send(res, 404, { ok: false, error: 'not found: ' + path }, requestId)
        await route.handler(deps, req, res, requestId, remote, url)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.error?.(
          JSON.stringify({ event: 'session-resume.api-error', requestId, error: message }),
        )
        return send(res, 500, { ok: false, error: message }, requestId)
      }
    },
  })
}