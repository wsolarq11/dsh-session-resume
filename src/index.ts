/**
 * @dsh-external/dsh-session-resume — host half.
 *
 * Two surfaces:
 * 1. A typert Remote service (ctx.remote.sessionResume.*) exposed to the client.
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
import { resolveSession, type SessionInfo } from './host/session-log.js'
import type { HostContext } from './host/types.js'
import { TYPERT } from '@dsh-external/dsh-session-resume/typert'

/** Typed projection of the generated host typert contribution (typed .d.ts is `unknown`). */
const HOST_TYPERT_CONTRIBUTION = TYPERT as {
  package: string
  face: string
  schemas?: unknown[]
  invocations: Array<{ namespace: string; method: string }>
}

import { SessionResumeService } from './host/session-resume-service.js'
export { SessionResumeService, SESSION_RESUME_SERVICE_KEY } from './host/session-resume-service.js'
export type { RemoteResolveResult } from './host/session-resume-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionResume: import('./host/session-resume-service.js').SessionResumeService
  }
  interface Events {
    'agent/pre-step'(event: unknown, next: () => Promise<unknown>): Promise<unknown>
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
  'typert',
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

/**
 * Endpoints this contribution exports, e.g. `sessionResume/resolvePlan`.
 */
function typertEndpoints(): string[] {
  return HOST_TYPERT_CONTRIBUTION.invocations.map((inv) => `${inv.namespace}/${inv.method}`)
}

/**
 * Install a persistent guardian that keeps `sessionResume/*` registered in the
 * host typert registry. A registered contribution is committed to `entries`
 * and remembered in `history` (`hasSeen`). When the registering fiber is
 * disposed (a reload/re-inject), `withdraw` removes the entries but leaves
 * `history`, so the gateway sees `hasSeen=true` + `get()=undefined` and refuses
 * with "withdrawn and SRC fallback is forbidden". This re-registers exactly
 * then — reactively on `local` change events plus a low-frequency poll — so a
 * reload never leaves the namespace permanently withdrawn.
 */
function installTypertSelfHeal(ctx: AppContext): void {
  const typert = ctx.typert
  if (!typert || HOST_TYPERT_CONTRIBUTION.invocations.length === 0) return
  const endpoints = new Set(typertEndpoints())

  /** Re-register only if the contribution is actually withdrawn (idempotent). */
  function healOnce(): void {
    try {
      const withdrawn = [...endpoints].some(
        (ep) => typert.local.hasSeen(ep) && typert.local.get(ep) === undefined,
      )
      if (!withdrawn) return
      typert.register(HOST_TYPERT_CONTRIBUTION)
      ctx.logger?.info?.('[session-resume] self-healed withdrawn typert registration')
    } catch (healError) {
      ctx.logger?.warn?.(JSON.stringify({ event: 'session-resume.typert-self-heal-error', error: String(healError) }))
    }
  }

  ctx.effect(() => {
    // React to registry changes: whenever a tracked endpoint is withdrawn,
    // re-register (guarded by idempotent healOnce).
    const unsubscribe =
      typeof typert.local.subscribe === 'function'
        ? typert.local.subscribe((change) => {
            if (change?.key !== undefined && endpoints.has(change.key)) healOnce()
          })
        : undefined
    // Belt-and-suspenders: the reload withdraw can dispatch asynchronously
    // after the subscribe event; a low-frequency poll guarantees recovery.
    const poll = globalThis.setInterval(healOnce, 3000)
    // Initial heal after the framework registration settles.
    const timer = globalThis.setTimeout(healOnce, 300)
    return () => {
      unsubscribe?.()
      globalThis.clearInterval(poll)
      globalThis.clearTimeout(timer)
    }
  }, 'session-resume: typt self-heal')
}

export function apply(ctx: AppContext): void {
  // Register the typert Remote service: instantiating it binds ctx.sessionResume
  // (via Service#constructor) so the typert gateway routes sessionResume.* to it.
  ctx.effect(
    () => {
      new SessionResumeService(ctx)
      return () => undefined
    },
    'session-resume: remote service',
  )

  // Persistent, event-driven self-heal for a withdrawn typt contribution.
  // A reload/re-inject that disposed the registering fiber leaves
  // `hasSeen(endpoint)=true` but `get(endpoint)=undefined`; the gateway then
  // refuses with "withdrawn and SRC fallback is forbidden" until someone
  // re-registers. The guardian re-registers in that exact state — reactively
  // on `local` change events plus a low-frequency poll as a belt-and-suspenders
  // fallback (a reload's withdraw can be dispatched asynchronously).
  installTypertSelfHeal(ctx)

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
