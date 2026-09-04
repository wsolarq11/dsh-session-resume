/**
 * Append-only order WAL: each attempt's state transitions are persisted as one
 * JSON line in `%TEMP%\dsh-session-resume\orders.jsonl` so a Host restart can
 * recover terminal (and planned) attempts and keep `/complete` idempotent.
 *
 * The WAL is intentionally append-only: no in-place edits, no deletion. The
 * latest line for an attemptId wins on load. Recovery keeps the last terminal
 * state (planned/accepted/failed) so a restarted Host never re-runs a plan
 * that was already accepted — but a planned-only attempt is still recoverable
 * for idempotent re-completion.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveCacheRoot } from '../../io/fs/cache-root.js'
import { isResumePlan } from '../plan/plan.js'
import type { ResumeOrderState } from './resume-order.js'

export const ORDER_WAL_FILENAME = 'orders.jsonl'

export interface ResumeOrderWal {
  load(): Promise<Map<string, ResumeOrderState>>
  append(state: ResumeOrderState): Promise<void>
  rewrite(states: readonly ResumeOrderState[]): Promise<void>
}

const RESUME_ORDER_STATUSES = new Set(['planned', 'accepted', 'failed'])

function parseResumeOrderState(value: unknown): ResumeOrderState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.attemptId !== 'string' || !candidate.attemptId) return null
  if (typeof candidate.sourceSessionId !== 'string' || !candidate.sourceSessionId) return null
  if (typeof candidate.status !== 'string' || !RESUME_ORDER_STATUSES.has(candidate.status)) return null
  if (candidate.targetSessionId !== undefined && typeof candidate.targetSessionId !== 'string') return null
  if (candidate.error !== undefined && typeof candidate.error !== 'string') return null
  if (candidate.plan !== undefined && candidate.plan !== null && !isResumePlan(candidate.plan)) return null
  return candidate as unknown as ResumeOrderState
}

export function resolveOrderWalPath(cacheRoot?: string): string {
  return join(resolveCacheRoot(cacheRoot), ORDER_WAL_FILENAME)
}

export class FileResumeOrderWal implements ResumeOrderWal {
  private readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(cacheRoot?: string) {
    this.path = resolveOrderWalPath(cacheRoot)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async load(): Promise<Map<string, ResumeOrderState>> {
    return this.enqueue(async () => {
      const states = new Map<string, ResumeOrderState>()
      let raw: string
      try {
        raw = await readFile(this.path, 'utf8')
      } catch {
        return states
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const state = parseResumeOrderState(JSON.parse(line))
          if (state) states.set(state.attemptId, state)
        } catch {
          // Skip corrupt lines; the WAL is append-only and a bad line is not fatal.
        }
      }
      return states
    })
  }

  async append(state: ResumeOrderState): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const line = JSON.stringify(state) + '\n'
      // Append via a temp file rename is not atomic-append; use appendFile with
      // a single write so queued appends cannot interleave partial lines.
      await appendFile(this.path, line, 'utf8')
    })
  }

  /** Rewrite the whole WAL (used when trimming old attempts). */
  async rewrite(states: readonly ResumeOrderState[]): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tempPath = `${this.path}.${randomUUID()}.tmp`
      const content = states.map((state) => JSON.stringify(state)).join('\n') + '\n'
      await writeFile(tempPath, content, 'utf8')
      await rename(tempPath, this.path)
    })
  }
}
