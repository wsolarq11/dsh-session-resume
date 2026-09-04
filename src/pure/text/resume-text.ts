/**
 * Pure resume-prompt text, shared by every client entry point.
 *
 * Layer-agnostic by design: no fetch, no DOM, no browser wiring. All prompt
 * building collapses onto the single `buildResumePrompt`; "path vs mention"
 * and "has workspace state" are data passed by the caller, not a family of
 * near-identical helpers.
 */

import { RESUME_INSTRUCTION } from './constants.js'

export { RESUME_INSTRUCTION }

/** The one workspace-state pointer suffix appended to resume text when packaged. */
export function workspaceStateSuffix(hasWorkspaceState: boolean): string {
  if (!hasWorkspaceState) return ''
  return '\n\n工作区状态（文件清单与 git 状态）已打包在快照的 workspace-state/ 目录下，请先阅读再继续。'
}

export interface ResumePromptOptions {
  /** Whether the snapshot packaged a workspace-state/ directory. */
  workspaceState?: boolean
  /** Custom effective instruction; falls back to the frozen default. */
  instruction?: string
}

/** One prompt shape for every entry point: a reference plus the shared instruction. */
export function buildResumePrompt(reference: string, opts: ResumePromptOptions = {}): string {
  const instruction = opts.instruction ?? RESUME_INSTRUCTION
  return `${reference} ${instruction}${workspaceStateSuffix(opts.workspaceState === true)}`
}