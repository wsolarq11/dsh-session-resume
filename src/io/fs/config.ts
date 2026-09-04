/**
 * Global user configuration for the resume plugin.
 *
 * The official DSH web profile does not expose a stable per-plugin config
 * registry to external plugins, so this plugin keeps one small JSON file on
 * the Host: `%TEMP%\dsh-session-resume\config.json`. The Host serves it over
 * the existing loopback-only, rate-limited HTTP surface; the client reads it
 * before building a resume prompt.
 *
 * Values are validated fail-closed: unknown keys are dropped, wrong types are
 * replaced by defaults, and normalization always returns the full effective
 * config so consumers never have to re-apply the defaults. The file is written
 * atomically (temp + rename).
 *
 * Host-only: touches node:fs/node:path; never import from the client bundle.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveCacheRoot } from './cache-root.js'
import { RESUME_INSTRUCTION } from '../../pure/text/constants.js'

export { RESUME_INSTRUCTION }

export const DEFAULT_SNAPSHOT_RETENTION = 10
export const MIN_SNAPSHOT_RETENTION = 1
export const MAX_SNAPSHOT_RETENTION = 100
export const MAX_INSTRUCTION_LENGTH = 2000
export const CONFIG_FILENAME = 'config.json'

export interface ResumeConfig {
  /** Custom resume instruction; falls back to the frozen default when empty. */
  resumeInstruction?: string
  /** How many per-session snapshots to keep. */
  snapshotRetention?: number
}

function defaultConfig(): ResumeConfig {
  return { resumeInstruction: RESUME_INSTRUCTION, snapshotRetention: DEFAULT_SNAPSHOT_RETENTION }
}

function normalizeInstruction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_INSTRUCTION_LENGTH) return undefined
  return trimmed
}

function normalizeRetention(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < MIN_SNAPSHOT_RETENTION || value > MAX_SNAPSHOT_RETENTION) return undefined
  return value
}

export function normalizeResumeConfig(input: unknown): ResumeConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaultConfig()
  const record = input as Record<string, unknown>
  const instruction = normalizeInstruction(record.resumeInstruction) ?? RESUME_INSTRUCTION
  const retention =
    normalizeRetention(record.snapshotRetention) ?? DEFAULT_SNAPSHOT_RETENTION
  return { resumeInstruction: instruction, snapshotRetention: retention }
}

/** Resolve the config file path. Honors the test-only cache root. */
export async function resolveConfigPath(cacheRoot?: string): Promise<string> {
  const root = resolveCacheRoot(cacheRoot)
  await mkdir(root, { recursive: true })
  return join(root, CONFIG_FILENAME)
}

export async function readResumeConfig(cacheRoot?: string): Promise<ResumeConfig> {
  const configPath = await resolveConfigPath(cacheRoot)
  try {
    const raw = await readFile(configPath, 'utf8')
    return normalizeResumeConfig(JSON.parse(raw))
  } catch {
    return defaultConfig()
  }
}

/** Per-cache-root serialization so writes to the same file never interleave,
 * while independent cache roots proceed in parallel (they never share temps). */
const configWriteQueues = new Map<string, Promise<void>>()

export function writeResumeConfig(
  config: ResumeConfig,
  cacheRoot?: string,
): Promise<ResumeConfig> {
  const normalized = normalizeResumeConfig(config)
  const rootKey = resolveCacheRoot(cacheRoot)
  const previous = configWriteQueues.get(rootKey) ?? Promise.resolve()
  const task = previous.then(async () => {
    const configPath = await resolveConfigPath(cacheRoot)
    const tempPath = `${configPath}.${randomUUID()}.tmp`
    await writeFile(tempPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
    await rename(tempPath, configPath)
    return normalized
  })
  const tail = task.then(
    () => undefined,
    () => undefined,
  )
  configWriteQueues.set(rootKey, tail)
  return task
}