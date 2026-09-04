/**
 * Canonical text scanner for the source forms the resume plugin understands:
 * an absolute Host log path, a legacy `/api/session.export` URL, or a canonical
 * `dsh-session:<payload>` mention. Consumers use this single model for
 * reference counting, first-hit selection, and Host text resolution instead of
 * maintaining separate path/URL/mention guards.
 */

import { findLogPathMatches, type LogPathHit } from './session-path.js'
import { findLogUrlMatches, type LogUrlHit } from './session-url.js'
import { decodeSessionPayload, SESSION_REFERENCE_SCHEME } from './session-uri.js'

export interface SourcePathRef extends LogPathHit {
  kind: 'path'
  /** Canonical dedup key for this recognized source. */
  sourceId: string
}

export interface SourceSessionRef extends LogUrlHit {
  kind: 'session'
  /** Canonical dedup key for this recognized source. */
  sourceId: string
}

export type SourceRef = SourcePathRef | SourceSessionRef

/** Scan text once and return every recognized source, ordered by text position. */
export function findSourceRefs(text: string): SourceRef[] {
  const pathRefs: SourcePathRef[] = findLogPathMatches(text).map((hit) => ({
    ...hit,
    kind: 'path',
    sourceId: hit.path,
  }))
  const sessionRefs: SourceSessionRef[] = findLogUrlMatches(text).map((hit) => ({
    ...hit,
    kind: 'session',
    sourceId: hit.id,
  }))
  return [...pathRefs, ...sessionRefs].sort((left, right) => left.start - right.start)
}

/** Session-only refs used by the official mention rewrite path. */
export function findSessionSourceRefs(text: string): SourceSessionRef[] {
  return findSourceRefs(text).filter((ref): ref is SourceSessionRef => ref.kind === 'session')
}

/** The first recognized source, useful for the input dock's primary action. */
export function findFirstSourceRef(text: string): SourceRef | null {
  return findSourceRefs(text)[0] ?? null
}

/** Distinct source identity count across both path and session references. */
export function countDistinctSourceRefs(text: string): number {
  return new Set(findSourceRefs(text).map((ref) => ref.sourceId)).size
}

/** Distinct source identity count for session references only. */
export function countDistinctSessionRefs(text: string): number {
  return new Set(findSessionSourceRefs(text).map((ref) => ref.sourceId)).size
}

/** Session-id from the first canonical `dsh-session:<payload>` mention, if any. */
const MENTION_TOKEN = new RegExp(`${SESSION_REFERENCE_SCHEME}([A-Za-z0-9_-]+)`)

export function findSessionIdFromMention(text: string): string | null {
  const match = MENTION_TOKEN.exec(text)
  if (!match) return null
  return decodeSessionPayload(match[1])
}
