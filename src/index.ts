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
import { MAX_REFERENCES } from './shared/constants.js'
import { decodeSessionPayload, encodeSessionUri, formatMention } from './shared/session-uri.js'
import {
  countDistinctLogSessions,
  findLogUrlMatch,
  findLogUrlMatches,
  parseLogUrl,
  type LogUrlHit,
} from './shared/session-url.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
  }
}

export const name = '@dsh-external/dsh-session-resume'
export const inject = ['webServer', 'sessionQuery', 'sessionReferenceResolver']
export { MAX_REFERENCES }

type AppContext = Context & {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: any, res: any) => void | Promise<void>
    }): () => void
  }
}

type SessionQueryLike = {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string } }>>
  readTitle(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ title: string } | undefined>
  readTitleSnapshots?(
    sessionIds: string[],
    signal?: AbortSignal,
  ): Promise<
    Array<
      | { title?: string | { title: string } }
      | { status: 'fulfilled'; value?: { title?: string | { title: string } } }
      | { status: 'rejected' }
      | undefined
    >
  >
}

export interface SessionInfo {
  sessionId: string
  label: string
  mention: string
}

const API_PREFIX = '/session-resume/api'
const MAX_BODY_BYTES = 64 * 1024
const RESUME_INSTRUCTION =
  '请继续这个会话：先阅读上面引用的会话快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续，不要要求用户重复粘贴日志。'

export function encodeSessionUriForExport(sessionId: string): string {
  return encodeSessionUri(sessionId)
}

export function decodeSessionPayloadForExport(payload: string): string | null {
  return decodeSessionPayload(payload)
}

export function formatMentionForExport(sessionId: string, label: string): string {
  return formatMention(sessionId, label)
}

export {
  countDistinctLogSessions,
  findLogUrlMatch,
  findLogUrlMatches,
  parseLogUrl,
  type LogUrlHit,
}

async function readSessionTitle(
  query: SessionQueryLike,
  sessionId: string,
): Promise<string | null> {
  try {
    if (typeof query.readTitleSnapshots === 'function') {
      const snapshots = await query.readTitleSnapshots([sessionId])
      const observation = snapshots?.[0]
      const titleValue =
        observation &&
        typeof observation === 'object' &&
        'value' in observation &&
        (observation as any).value?.title !== undefined
          ? (observation as any).value.title
          : (observation as any)?.title
      const title =
        titleValue && typeof titleValue === 'object' && typeof titleValue.title === 'string'
          ? titleValue.title
          : typeof titleValue === 'string'
            ? titleValue
            : null
      return typeof title === 'string' && title ? title : null
    }
    const title = await query.readTitle(sessionId)
    return typeof title?.title === 'string' && title.title ? title.title : null
  } catch {
    return null
  }
}

export async function resolveSession(
  ctx: AppContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const query = (ctx as any).get?.('sessionQuery') ?? (ctx as any).sessionQuery
  if (!query || typeof query.listSessions !== 'function') return null
  try {
    const records = await query.listSessions()
    if (!records.some((record: any) => record.header?.id === sessionId)) return null
    const label = (await readSessionTitle(query, sessionId)) ?? sessionId
    return { sessionId, label, mention: formatMention(sessionId, label) }
  } catch {
    return null
  }
}

export async function resolveFromText(
  ctx: AppContext,
  text: string,
): Promise<SessionInfo | null> {
  const urlHit = findLogUrlMatch(text)
  if (urlHit) return resolveSession(ctx, urlHit.id)
  const bare = text.match(/dsh-session:([A-Za-z0-9_-]+)/)
  if (bare) {
    const id = decodeSessionPayload(bare[1])
    if (id) return resolveSession(ctx, id)
  }
  return null
}

export async function rewriteText(
  ctx: AppContext,
  text: string,
  targetAgentId: string,
): Promise<string> {
  const hits = findLogUrlMatches(text)
  if (hits.length === 0) return text

  const infos = new Map<string, SessionInfo>()
  for (const hit of hits) {
    if (hit.id === targetAgentId || infos.has(hit.id)) continue
    if (infos.size >= MAX_REFERENCES) continue
    const info = await resolveSession(ctx, hit.id)
    if (info) infos.set(hit.id, info)
  }

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
  message: any,
  targetAgentId: string,
): Promise<any> {
  if (!message || message.source?.kind !== 'user' || !Array.isArray(message.content)) return message
  let changed = false
  const content: any[] = []
  for (const block of message.content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      content.push(block)
      continue
    }
    const rewritten = await rewriteText(ctx, block.text, targetAgentId)
    if (rewritten !== block.text) changed = true
    content.push(rewritten === block.text ? block : { ...block, text: rewritten })
  }
  return changed ? { ...message, content } : message
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: unknown) => {
      body +=
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : String(chunk)
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        reject(new Error('request body too large'))
        req.resume()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function exportDownloadPath(sessionId: string): string {
  return '/api/session.export?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=true'
}

export function apply(ctx: AppContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req: any, res: any) => {
          const send = (code: number, payload: unknown): void => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(payload))
          }
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const path = url.pathname.replace(API_PREFIX, '') || '/'
            if (req.method === 'GET' && path === '/copy') {
              const sessionId = url.searchParams.get('sessionId') ?? ''
              if (!sessionId) return send(400, { ok: false, error: 'sessionId 必填' })
              const info = await resolveSession(ctx, sessionId)
              if (!info) return send(404, { ok: false, error: '会话不存在或不可读' })
              return send(200, { ok: true, ...info, downloadPath: exportDownloadPath(info.sessionId) })
            }
            if (req.method === 'POST' && path === '/resolve') {
              let body: { text?: unknown } = {}
              try {
                const raw = await readBody(req)
                if (raw) body = JSON.parse(raw)
              } catch (error) {
                if (error instanceof Error && error.message === 'request body too large') {
                  return send(400, { ok: false, error: '请求体过大' })
                }
                return send(400, { ok: false, error: '请求体不是有效 JSON' })
              }
              const text = String(body.text ?? '').trim()
              const info = await resolveFromText(ctx, text)
              if (!info) return send(404, { ok: false, error: '无法识别会话日志链接，或会话不存在' })
              return send(200, { ok: true, ...info, downloadPath: exportDownloadPath(info.sessionId) })
            }
            return send(404, { ok: false, error: 'not found: ' + path })
          } catch (error) {
            return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'session-resume: api',
  )

  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
        const decision = await next()
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        const targetAgentId = String(payload.agent?.id ?? '')
        const messages = await Promise.all(
          decision.messages.map((message: any) => rewriteMessage(ctx, message, targetAgentId)),
        )
        return { ...decision, messages }
      }),
    'session-resume: pre-step',
  )

  ctx.logger?.info?.('[session-resume] host ready: log URL auto-resume enabled')
}

export const resumeInstruction = RESUME_INSTRUCTION
