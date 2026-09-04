/** Host-side workspace resolution: original session membership wins, then canonical path registration. */

import { readService } from '../../orchestration/host/service.js'
import type { HostContext, WorkspaceLike, WorkspaceRegistryLike } from '../../contract/host-types.js'

export type ResumeWorkspaceResolution =
  | { ok: true; workspaceId: string; cwd: string; created: boolean }
  | { ok: false; status: number; error: string }

function readWorkspaceRegistry(ctx: HostContext): WorkspaceRegistryLike | null {
  return readService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')
}

function fail(status: number, error: string): ResumeWorkspaceResolution {
  return { ok: false, status, error }
}

function ok(workspaceId: string, cwd: string, created: boolean): ResumeWorkspaceResolution {
  return { ok: true, workspaceId, cwd, created }
}

type AttachSessionResult = { ok: true } | { ok: false; error: string }

async function attachSourceSession(
  workspace: WorkspaceLike,
  sourceSessionId: string,
): Promise<AttachSessionResult> {
  // No attach capability is not an error: the workspace is still valid.
  if (typeof workspace.attachSession !== 'function') return { ok: true }
  try {
    await workspace.attachSession(sourceSessionId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function resolveResumeWorkspace(
  ctx: HostContext,
  sourceSessionId: string,
  cwd: string | undefined,
): Promise<ResumeWorkspaceResolution> {
  const registry = readWorkspaceRegistry(ctx)
  if (!registry || typeof registry.list !== 'function') {
    return fail(501, '当前部署没有工作区注册表，无法确认续跑目标工作区')
  }

  const attached = registry.list().find((workspace) => workspace.sessionIds.includes(sourceSessionId))
  if (attached) return ok(String(attached.id), attached.path, false)
  if (!cwd) return fail(409, '源会话没有工作目录，无法解析原工作区')

  if (typeof registry.resolveByPath === 'function') {
    try {
      const resolved = await registry.resolveByPath(cwd)
      if (resolved) return ok(String(resolved.id), resolved.path, false)
    } catch (error) {
      return fail(500, `解析源工作区路径失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (typeof registry.create !== 'function') {
    return fail(409, `未找到与源会话工作目录匹配的已注册工作区: ${cwd}`)
  }

  try {
    const created = await registry.create(cwd)
    const attach = await attachSourceSession(created, sourceSessionId)
    if (!attach.ok) {
      let message = `源会话无法归入新建工作区: ${attach.error}`
      if (typeof created.remove === 'function') {
        try {
          await created.remove()
          message += '；已回滚新建工作区'
        } catch (removeError) {
          message += `；新建工作区回滚失败: ${removeError instanceof Error ? removeError.message : String(removeError)}`
        }
      } else {
        message += '；新建工作区未提供回滚能力，可能残留'
      }
      return fail(500, message)
    }
    return ok(String(created.id), created.path, true)
  } catch (error) {
    return fail(409, `源目录无法注册为工作区: ${error instanceof Error ? error.message : String(error)}`)
  }
}
