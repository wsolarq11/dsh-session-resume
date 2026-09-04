/**
 * Client-side structural contracts for the resume plugin.
 */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import '@dsh-external/dsh-session-resume/remote'
import type { ResumeSessionsClient, ResumeWorkspaceClient } from './resume-client.js'
import type { LogPathHit } from '../shared/session-path.js'
import type { LogUrlHit } from '../shared/session-url.js'
import type { SourceRef } from '../shared/source-ref.js'
import type { ResumePlan } from '../shared/plan.js'

/** The two slot-registry methods the plugin uses. */
export interface SlotsLike {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id: string
    order: number
    label: () => string
  }, component: unknown): () => void
}

/** The plugin's client-side context (injected services). */
export interface ClientContext {
  slots: SlotsLike
  sessions?: ResumeSessionsClient
  workspaces?: ResumeWorkspaceClient
  remote?: TypertClientRemote
  effect(fn: () => unknown, label?: string): unknown
}

export interface HeaderButtonProps { sessionId?: string }

export interface DockProps {
  sessionId?: string
  input?: { draft?: string }
  inputActions?: { setDraft?(text: string): void; submit?(): void }
}

export type { ResumePlan } from '../shared/plan.js'

export interface ResolvedLogUrl {
  sessionId: string
  label: string
  mention: string
}

export type { LogPathHit, LogUrlHit, SourceRef }
