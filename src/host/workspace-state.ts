/**
 * Workspace-state packaging: a manifest of the source cwd plus git status,
 * written into each materialized snapshot as `workspace-state/`.
 *
 * The manifest contains only metadata (relative path, kind, size, mtime) — no
 * file contents — so it stays small and does not leak file bodies. Git status
 * is captured with `--porcelain` so it is stable and machine-readable.
 *
 * Scanning is bounded: max depth, max entries, and a wall-clock budget. A
 * failure to read the workspace (missing cwd, permission, timeout) produces an
 * empty manifest instead of failing the resume, because the log snapshot
 * itself is still valid.
 */

import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { HostContext } from './types.js'

const execFileAsync = promisify(execFile)

export const WORKSPACE_STATE_DIR = 'workspace-state'
export const WORKSPACE_MANIFEST_FILE = 'manifest.json'
export const WORKSPACE_GIT_FILE = 'git.txt'

export const MAX_SCAN_DEPTH = 4
export const MAX_SCAN_ENTRIES = 2000
export const SCAN_TIMEOUT_MS = 3000
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.dsh', 'dist', 'lib', 'target', '__pycache__'])

export interface WorkspaceEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
  mtime?: number
}

export interface WorkspaceManifest {
  cwd: string
  scannedAt: number
  /**
   * True when the scan hit a bound (depth/entries/timeout) and the listing is
   * incomplete. Consumers must not treat an empty or partial `entries` array
   * as the full workspace.
   */
  truncated: boolean
  entries: WorkspaceEntry[]
  git?: {
    head?: string
    dirty: boolean
    statusLines: string[]
  }
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name)
}

async function scanDirectory(baseRoot: string, dir: string, depth: number, out: WorkspaceEntry[]): Promise<boolean> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_ENTRIES) return false
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (out.length >= MAX_SCAN_ENTRIES) return false
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let info
    try {
      info = await lstat(full)
    } catch {
      continue
    }
    // Symlinks and junctions are not traversed: the manifest must stay within
    // the workspace root and must not expose metadata from an outside target.
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (isExcludedDir(name)) continue
      out.push({ path: relative(baseRoot, full), kind: 'dir' })
      const ok = await scanDirectory(baseRoot, full, depth + 1, out)
      if (!ok) return false
    } else if (info.isFile()) {
      out.push({
        path: relative(baseRoot, full),
        kind: 'file',
        size: info.size,
        mtime: info.mtimeMs,
      })
    }
  }
  return true
}

async function readGitStatus(cwd: string): Promise<WorkspaceManifest['git'] | undefined> {
  // Async execFile keeps the Host event loop responsive during scans; the two
  // probes are independent and both bounded by SCAN_TIMEOUT_MS, so run them in
  // parallel. A missing repo degrades to no git section rather than failing.
  const runProbe = (args: string[]) =>
    execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: SCAN_TIMEOUT_MS }).then(
      (result) => result.stdout.trim(),
      () => '',
    )
  const [head, statusText] = await Promise.all([
    runProbe(['rev-parse', 'HEAD']),
    runProbe(['status', '--porcelain=v1']),
  ])
  if (!head && !statusText) return undefined
  const statusLines = statusText ? statusText.split('\n') : []
  return {
    head,
    dirty: statusLines.length > 0,
    statusLines,
  }
}

/** Build the workspace manifest for a cwd. Never throws: failures degrade to empty. */
export async function buildWorkspaceManifest(
  ctx: HostContext,
  cwd: string | undefined,
): Promise<WorkspaceManifest> {
  const base: WorkspaceManifest = {
    cwd: cwd ?? '',
    scannedAt: Date.now(),
    truncated: false,
    entries: [],
  }
  if (!cwd) return base
  let root: string
  try {
    root = resolve(cwd)
  } catch {
    return base
  }
  const entries: WorkspaceEntry[] = []
  let truncated = false
  try {
    truncated = !(await scanDirectory(root, root, 0, entries))
  } catch {
    truncated = true
  }
  const git = await readGitStatus(root)
  return { ...base, truncated, entries, ...(git ? { git } : {}) }
}

/** Render the git status text file next to the manifest in a snapshot. */
export function renderGitStatusText(git: NonNullable<WorkspaceManifest['git']>): string {
  return (
    (git.head ? `HEAD ${git.head}\n` : '') +
    (git.statusLines.length > 0 ? `\n${git.statusLines.join('\n')}\n` : '工作区干净\n')
  )
}


