/**
 * @dsh-external/dsh-session-resume — host half.
 *
 * Two surfaces:
 * 1. `/session-resume/api` JSON routes used by the client header/dock UI.
 * 2. `agent/pre-step` rewrite: a direct user message containing a session-log
 *    download URL (`/api/session.export?sessionId=...`) is rewritten into the
 *    canonical `@[label](dsh-session:...)` mention. The official
 *    `session-reference` prepend listener runs before us, calls next() (which
 *    includes this listener), then prepares the returned messages, so the
 *    pasted archive URL automatically becomes a real cross-session snapshot.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MAX_REFERENCES, RESUME_INSTRUCTION } from './shared/constants.js'
import { findSessionSourceRefs } from './shared/source-ref.js'
import { registerResumeApi } from './host/api.js'
import { resolveSession, type SessionInfo } from './host/session-log.js'
import type { HostContext } from './host/types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
  }
}

export const name = '@dsh-external/dsh-session-resume'
export const inject = [
  'webServer',
  'sessionQuery',
  'sessionPersistence',
  'sessions',
  'workspaceRegistry',
  'attachments',
]
export { MAX_REFERENCES, RESUME_INSTRUCTION }

type AppContext = Context & HostContext

/** A user message block that may carry a legacy session-log URL. */
interface PreStepTextBlock {
  type?: string
  text?: unknown
}

/** A user message whose content is a list of blocks. */
interface PreStepMessage {
  source?: { kind?: string }
  content?: unknown[]
}

/** The pre-step decision shape the plugin inspects and rewrites. */
interface PreStepDecision {
  kind?: string
  messages?: unknown[]
}

export async function rewriteText(
  ctx: AppContext,
  text: string,
  targetAgentId: string,
): Promise<string> {
  const hits = findSessionSourceRefs(text)
  if (hits.length === 0) return text

  const distinctIds = [...new Set(hits.map((hit) => hit.id))].filter((id) => id !== targetAgentId)
  if (distinctIds.length > MAX_REFERENCES) return text

  const infos = new Map<string, SessionInfo>()
  const resolved = await Promise.all(distinctIds.map((id) => resolveSession(ctx, id)))
  for (let index = 0; index < distinctIds.length; index += 1) {
    const info = resolved[index]
    if (info) infos.set(distinctIds[index], info)
  }
  // All-or-nothing: if any reference in the capped set cannot be resolved,
  // leave the whole message unchanged rather than emitting a mixed
  // mention + raw-URL rewrite.
  if (infos.size !== distinctIds.length) return text

  let output = ''
  let last = 0
  let changed = false
  for (const hit of hits) {
    const info = infos.get(hit.id)
    if (!info) continue
    output += text.slice(last, hit.start) + info.mention
    last = hit.end
    changed = true
  }
  if (!changed) return text
  return output + text.slice(last)
}

async function rewriteMessage(
  ctx: AppContext,
  message: PreStepMessage,
  targetAgentId: string,
): Promise<PreStepMessage> {
  if (!message || message.source?.kind !== 'user' || !Array.isArray(message.content)) return message
  let changed = false
  const content: unknown[] = []
  for (const block of message.content) {
    const textBlock = block as PreStepTextBlock | null | undefined
    if (!textBlock || textBlock.type !== 'text' || typeof textBlock.text !== 'string') {
      content.push(block)
      continue
    }
    const rewritten = await rewriteText(ctx, textBlock.text, targetAgentId)
    if (rewritten !== textBlock.text) changed = true
    content.push(rewritten === textBlock.text ? block : { ...textBlock, text: rewritten })
  }
  return changed ? { ...message, content } : message
}

export function apply(ctx: AppContext): void {
  ctx.effect(
    () => registerResumeApi(ctx),
    'session-resume: api',
  )

  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
        const decision = (await next()) as PreStepDecision | null | undefined
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        const agentId = (payload as { agent?: { id?: unknown } } | null | undefined)?.agent?.id
        const targetAgentId = String(agentId ?? '')
        const messages = await Promise.all(
          decision.messages.map((message) => rewriteMessage(ctx, message as PreStepMessage, targetAgentId)),
        )
        return { ...decision, messages }
      }),
    'session-resume: pre-step',
  )

  ctx.logger?.info?.('[session-resume] host ready: Host log path auto-resume enabled')
}
