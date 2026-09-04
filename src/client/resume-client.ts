/**
 * Client-only resume wiring: reading the effective instruction over the
 * loopback API and creating/reconnecting + prompting the target session.
 *
 * Client-only: uses the browser `fetch` and the injected session/workspace
 * clients. Never import this module from the Host bundle. The pure text
 * builders it depends on live in `../shared/resume-text.js`.
 */

import { RESUME_INSTRUCTION, buildResumePrompt, type ResumePromptOptions } from '../shared/resume-text.js'

export { RESUME_INSTRUCTION }

export interface ResumeSessionsClient {
  create(opts?: { cwd?: string; workspaceId?: string; sessionId?: string }): Promise<string>
  open?(id: string): void
  binding?(id: string): {
    session?: {
      prompt?(
        content: readonly unknown[],
        mode: 'queue' | 'steer',
      ): Promise<{ ok?: boolean }>
    }
  } | undefined
}

export interface ResumeWorkspaceClient {
  connectWorkspace?(workspaceId: string): Promise<string>
}

export interface ResumeCreateTarget {
  workspaceId?: string
  cwd?: string
}

function openResumeSession(
  client: ResumeSessionsClient | undefined,
  newId: string,
): void {
  if (client && typeof client.open === 'function') client.open(newId)
}

/**
 * Create or reuse the target session and return its id. The open/side-effecting
 * wiring happens here; callers only need the resulting id to prompt and report.
 */
export async function connectResumeSession(
  client: ResumeSessionsClient | undefined,
  target: ResumeCreateTarget,
  workspaceClient?: ResumeWorkspaceClient,
): Promise<string> {
  if (!client || typeof client.create !== 'function') {
    throw new Error('客户端会话服务不可用')
  }
  if (target.workspaceId !== undefined) {
    const newId =
      workspaceClient && typeof workspaceClient.connectWorkspace === 'function'
        ? await workspaceClient.connectWorkspace(target.workspaceId)
        : await client.create({ workspaceId: target.workspaceId })
    openResumeSession(client, newId)
    return newId
  }
  throw new Error('没有续跑目标工作区，已停止创建会话')
}

/**
 * Resolve the effective resume instruction: a configured custom instruction
 * wins, otherwise the frozen default. Reads the Host-side global config via
 * the loopback API.
 */
export async function resolveEffectiveInstruction(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetchImpl('/session-resume/api/config', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return RESUME_INSTRUCTION
    const data = (await response.json()) as {
      config?: { resumeInstruction?: unknown }
    }
    const custom = data.config?.resumeInstruction
    if (typeof custom === 'string' && custom.trim()) return custom.trim()
    return RESUME_INSTRUCTION
  } catch {
    return RESUME_INSTRUCTION
  }
}

/**
 * The canonical "resolve the effective resume instruction" seam. An explicit
 * instruction wins; otherwise the configured custom instruction is fetched, or
 * the frozen default. Every client prompt path routes through this one function
 * so an instruction-resolution change needs exactly one edit.
 */
export async function resolveResumeInstruction(embedded?: string): Promise<string> {
  return embedded ?? (await resolveEffectiveInstruction())
}

/**
 * Build a resume prompt, resolving the effective instruction when the caller
 * did not supply one. This is the canonical "resolve instruction then build
 * prompt" sequence shared by every client entry point, single-sourced instead
 * of re-composed at each call site.
 */
export async function buildResumePromptWithInstruction(
  reference: string,
  opts: ResumePromptOptions = {},
): Promise<string> {
  const instruction = await resolveResumeInstruction(opts.instruction)
  return buildResumePrompt(reference, { ...opts, instruction })
}

export async function promptResumeSession(
  client: ResumeSessionsClient | undefined,
  newId: string,
  text: string,
): Promise<{ accepted: boolean; error?: string }> {
  try {
    const binding = client && typeof client.binding === 'function' ? client.binding(newId) : undefined
    const session = binding?.session
    if (session && typeof session.prompt === 'function') {
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (result && result.ok === true) return { accepted: true }
    }
    return { accepted: false, error: '新会话没有可用的发送面' }
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) }
  }
}