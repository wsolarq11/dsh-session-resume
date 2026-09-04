/**
 * Cache-root resolution shared by every Host module that writes under the
 * resume cache.
 *
 * The plugin keeps all on-disk state (config.json, orders.jsonl, per-session
 * snapshot trees, workspace-state materializations) under one base directory.
 * Production uses `%TEMP%\dsh-session-resume`; tests inject a scratch root via
 * `ctx.resumeCacheRoot`. Every Host module must resolve through this single
 * function so the default and the override stay consistent.
 *
 * Host-only: touches node:os/node:path; never import from the client bundle.
 */

import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The default on-disk base directory for all resume cache state. */
function defaultCacheRoot(): string {
  return join(tmpdir(), 'dsh-session-resume')
}

/** Resolve the effective (possibly test-only) cache root. */
export function resolveCacheRoot(cacheRoot?: string): string {
  return resolve(cacheRoot && typeof cacheRoot === 'string' && cacheRoot ? cacheRoot : defaultCacheRoot())
}