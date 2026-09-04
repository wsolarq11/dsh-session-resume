/**
 * Shared Host service access: read a service either from the direct context
 * property or through `ctx.get(name)`, whichever the runtime exposes.
 *
 * The Cordis runtime Context is a Proxy that throws for undeclared service
 * reads, so every service read must go through this single helper instead of
 * touching `ctx.<name>` directly. Keeping one helper here removes the
 * per-module `readXxx` duplication across `session-log.ts`,
 * `log-materialize.ts`, and `workspace.ts`.
 */

import type {
  AttachmentStoreLike,
  HostContext,
  SessionPersistenceLike,
  SessionQueryLike,
  SessionStoreLike,
} from './types.js'
import { resolveCacheRoot } from './cache-root.js'

/** The HostContext field that carries the optional test-only cache root. */
export type CacheRootFacadeLike = { resumeCacheRoot?: string }

export function readService<T>(
  ctx: HostContext,
  name: keyof HostContext,
): T | null {
  const direct = ctx[name]
  if (direct) return direct as T
  const injected = ctx.get?.(name as string)
  return injected && typeof injected === 'object' ? (injected as T) : null
}

/**
 * Read the optional test-only cache root through the runtime's getter-only
 * facade: direct property reads throw "cannot get ... without inject", so
 * inspect via `Reflect.has` (no read) and fall back to the default TEMP root.
 * Kept with the other facade reads so the "context may wrap in a getter-only
 * Proxy" invariant is spelled once, in this module.
 */
export function readCacheRootSafe(ctx: CacheRootFacadeLike): string {
  const hasTestRoot = Reflect.has(ctx, 'resumeCacheRoot')
  return resolveCacheRoot(hasTestRoot && ctx.resumeCacheRoot ? ctx.resumeCacheRoot : undefined)
}

/** Read the session query service (used by log resolution and title reads). */
export function readSessionQuery(ctx: HostContext): SessionQueryLike | null {
  return readService<SessionQueryLike>(ctx, 'sessionQuery')
}

/** Read the session persistence service (raw log artifact access). */
export function readSessionPersistence(ctx: HostContext): SessionPersistenceLike | null {
  return readService<SessionPersistenceLike>(ctx, 'sessionPersistence')
}

/** Read the live session store (flush support). */
export function readSessionStore(ctx: HostContext): SessionStoreLike | null {
  return readService<SessionStoreLike>(ctx, 'sessions')
}

/** Read the attachment store (media materialization). */
export function readAttachments(ctx: HostContext): AttachmentStoreLike | null {
  return readService<AttachmentStoreLike>(ctx, 'attachments')
}

/**
 * Flush one live session's in-memory log to disk so the raw artifact read
 * below sees the latest state. No-op when the session is not live or the
 * store is unavailable; called by both log resolution and materialization.
 */
export async function flushLiveSession(ctx: HostContext, sessionId: string): Promise<void> {
  const sessions = readSessionStore(ctx)
  if (!sessions || typeof sessions.get !== 'function' || typeof sessions.flush !== 'function') return
  const session = sessions.get(sessionId)
  if (!session) return
  await sessions.flush(session)
}