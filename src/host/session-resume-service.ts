import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveFromText as resolveFromTextCore, resolveSession as resolveSessionCore, resolveSessionLogPath, type SessionLogPathResult } from './session-log.js'
import { readResumeConfig, writeResumeConfig, normalizeResumeConfig, type ResumeConfig } from './config.js'
import { ResumeOrderBook } from './resume-order.js'
import { FileResumeOrderWal } from './order-wal.js'
import { resolveResumePlan, resolveResumeBatchPlan, type ResumePlan } from './resume-plan.js'
import { listSessionSnapshots, type StoredSnapshot } from './snapshot-store.js'
import { readCacheRootSafe } from './service.js'
import { logResumeAudit } from './audit.js'
import type { HostContext } from './types.js'

export const SESSION_RESUME_SERVICE_KEY = 'sessionResume'

/** Flat, JSON-projectable resolve outcome. */
export interface RemoteResolveResult {
  ok: boolean
  sessionId?: string
  label?: string
  mention?: string
  error?: string
}

/** Flat terminal completion outcome — projects like the resolve result. */
export interface RemoteCompleteResult {
  ok: boolean
  attemptId: string
  status: string
  targetSessionId?: string
  error?: string
}

/** Deep-remove `undefined` values so the gateway's JSON-safety walk never sees one. */
function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    out[key] = stripUndefined(item)
  }
  return out as T
}

export class SessionResumeService extends TypertRemoteService {
  private readonly orders: ResumeOrderBook
  static inject = ['sessionQuery']
  constructor(ctx: HostContext) {
    super(ctx as never, 'sessionResume')
    const cacheRoot = readCacheRootSafe(ctx)
    this.orders = new ResumeOrderBook({ wal: new FileResumeOrderWal(cacheRoot), logger: ctx.logger })
    void this.orders.loadFromWal()
  }
  private host(): HostContext { return this.ctx as unknown as HostContext }

  @Remote('resolveFromText')
  async resolveFromText(text: string): Promise<RemoteResolveResult> {
    if (!text || !text.trim()) return { ok: false, error: '缺少文本' }
    const info = await resolveFromTextCore(this.host(), text.trim())
    if (!info) return { ok: false, error: '无法识别会话日志链接，或会话不存在' }
    return { ok: true, sessionId: info.sessionId, label: info.label, mention: info.mention }
  }

  @Remote('resolveSession')
  async resolveSession(sessionId: string): Promise<RemoteResolveResult> {
    if (!sessionId) return { ok: false, error: 'sessionId 必填' }
    const info = await resolveSessionCore(this.host(), sessionId)
    if (!info) return { ok: false, error: '会话不存在或不可读' }
    return { ok: true, sessionId: info.sessionId, label: info.label, mention: info.mention }
  }

  @Remote('resolvePlan')
  async resolvePlan(sessionId: string, attemptId: string, snapshotId: string): Promise<ResumePlan> {
    if (!sessionId) return { ok: false, status: 400, error: 'sessionId 必填且必须是字符串' }
    const id = attemptId || crypto.randomUUID()
    return this.orders.run(sessionId, id, () => resolveResumePlan(this.host(), sessionId, id, snapshotId || undefined))
  }

  @Remote('resolveBatchPlan')
  async resolveBatchPlan(sessionIds: string[], attemptId: string, snapshotIds: Record<string, string>): Promise<ResumePlan> {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return { ok: false, status: 400, error: 'sessionIds 必填且至少一个' }
    const id = attemptId || crypto.randomUUID()
    const mapped = snapshotIds && Object.keys(snapshotIds).length > 0 ? snapshotIds : undefined
    return this.orders.run(sessionIds[0], id, () => resolveResumeBatchPlan(this.host(), sessionIds, id, mapped))
  }

  @Remote('completeResume')
  async completeResume(attemptId: string, status: 'accepted' | 'failed', targetSessionId: string, error: string): Promise<RemoteCompleteResult> {
    const state = await this.orders.complete(attemptId, targetSessionId || undefined, status, error || undefined)
    if (!state) return { ok: false, attemptId, status: 'failed', error: 'attempt 不存在，Host 重启后内存订单已失效' }
    if (state.status !== 'planned' && state.status !== status) {
      return { ok: false, attemptId, status: state.status, error: `attempt 已处于 ${state.status} 终态` }
    }
    const targetWorkspaceId = state.plan && state.plan.ok ? state.plan.target.workspaceId : undefined
    logResumeAudit(this.host().logger, {
      requestId: 'remote', remoteAddress: 'typert', attemptId,
      sourceSessionId: state.sourceSessionId, targetWorkspaceId, targetSessionId: state.targetSessionId,
      status: state.status === 'planned' ? 'resolved' : state.status, error: state.error, durationMs: 0,
    })
    return stripUndefined({ ok: true, attemptId, status: state.status, targetSessionId: state.targetSessionId, error: state.error })
  }

  @Remote('getConfig')
  async getConfig(): Promise<ResumeConfig> {
    return readResumeConfig(readCacheRootSafe(this.host()))
  }

  @Remote('setConfig')
  async setConfig(config: ResumeConfig): Promise<ResumeConfig> {
    const normalized = normalizeResumeConfig(config)
    return writeResumeConfig(normalized, readCacheRootSafe(this.host()))
  }

  @Remote('listSnapshots')
  async listSnapshots(sessionId: string): Promise<StoredSnapshot[]> {
    if (!sessionId) return []
    return listSessionSnapshots(this.host(), sessionId)
  }

  @Remote('resolveLogPath')
  async resolveLogPath(sessionId: string): Promise<SessionLogPathResult> {
    if (!sessionId) return { ok: false, status: 404, error: 'sessionId 必填' }
    return resolveSessionLogPath(this.host(), sessionId)
  }
}
