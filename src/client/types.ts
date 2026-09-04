/**
 * Client-side structural contracts for the resume plugin.
 *
 * The official slots `register` type is a heavy generic contract
 * (`ComposedProps`/`RendersCheck`) that the shell composes at runtime. The
 * plugin only needs the two methods it calls (`inject`/`register`) and the
 * props the shell actually passes (`sessionId`, `input`, `inputActions`), so
 * this module declares the minimal structural face instead of importing the
 * full generic machinery. Keeping the face here also lets the order/button/
 * dock modules stay free of React and slots imports.
 */

import type { ResumeSessionsClient, ResumeWorkspaceClient } from './resume-client.js'
import type { LogPathHit } from '../shared/session-path.js'
import type { LogUrlHit } from '../shared/session-url.js'
import type { SourceRef } from '../shared/source-ref.js'
import type { ResumePlan } from '../shared/plan.js'

/** The two slot-registry methods the plugin uses (minimal structural face of the shell's slots). */
export interface SlotsLike {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id: string
    order: number
    label: () => string
  }, component: unknown): () => void
}

/**
 * The plugin's client-side context (injected services).
 *
 * Sessions and workspaces are the same structural faces the shared executor
 * consumes (`ResumeSessionsClient`/`ResumeWorkspaceClient`), so the client
 * declares them by contract here instead of duplicating the shapes.
 */
export interface ClientContext {
  slots: SlotsLike
  sessions?: ResumeSessionsClient
  workspaces?: ResumeWorkspaceClient
  effect(fn: () => unknown, label?: string): unknown
}

/** Props the shell passes to a header-utility slot occupant. */
export interface HeaderButtonProps {
  sessionId?: string
}

/** Props the shell passes to an input-dock slot occupant. */
export interface DockProps {
  sessionId?: string
  input?: { draft?: string }
  inputActions?: {
    setDraft?(text: string): void
    submit?(): void
  }
}

export type { ResumePlan } from '../shared/plan.js'

/** A resolved legacy URL hit with its session info. */
export interface ResolvedLogUrl {
  sessionId: string
  label: string
  mention: string
}

export type { LogPathHit, LogUrlHit, SourceRef }