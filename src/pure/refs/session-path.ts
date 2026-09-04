/**
 * Shared detection for the Host's absolute session-log artifact path.
 *
 * The official export ZIP is not the source of truth here: we locate the same
 * backend-owned `session.jsonl[.zstd]` path on the Host, so the client can pass
 * that path into a new session without asking the browser to download a file.
 */

export interface LogPathHit {
  path: string
  start: number
  end: number
}

const LOG_FILE_SUFFIXES = ['session.jsonl.zstd', 'session.jsonl'] as const

const WINDOWS_PATH = /^[A-Za-z]:[\\/].*(?:[\\/]session\.jsonl(?:\.zstd)?)$/
const POSIX_PATH = /^\/(?:[^/\0]+\/)*session\.jsonl(?:\.zstd)?$/

export function isSessionLogPath(value: string): boolean {
  return WINDOWS_PATH.test(value) || POSIX_PATH.test(value)
}

/**
 * Scan backwards from the log filename marker to the path start.
 *
 * The path begins after a word boundary; the scan stops at the first
 * delimiter so prose glued to the path (`继续D:\...`) is not absorbed. A
 * space is only a boundary when everything before it already forms a valid
 * path (so `C:\Program Files\...` keeps its inner spaces).
 */
function pathStartBefore(text: string, markerIndex: number, end: number): number {
  let start = markerIndex
  while (start > 0) {
    const previous = text[start - 1]
    if (previous === '\r' || previous === '\n' || previous === '\t') break
    if (previous === '"' || previous === "'" || previous === '`') break
    if (previous === '(' || previous === '（' || previous === '[' || previous === '【') break
    if (previous === ')' || previous === '）' || previous === ']' || previous === '】') break
    if (previous === ' ' && isSessionLogPath(text.slice(start, end))) break
    start--
  }
  return start
}

export function findLogPathMatches(text: string): LogPathHit[] {
  const hits: LogPathHit[] = []
  let cursor = 0
  while (cursor < text.length) {
    let markerIndex = -1
    let markerSuffix = ''
    for (const suffix of LOG_FILE_SUFFIXES) {
      const index = text.indexOf(suffix, cursor)
      if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
        markerIndex = index
        markerSuffix = suffix
      }
    }
    if (markerIndex < 0) break

    const end = markerIndex + markerSuffix.length
    const start = pathStartBefore(text, markerIndex, end)
    const path = text.slice(start, end)
    if (isSessionLogPath(path)) hits.push({ path, start, end })
    cursor = end
  }
  return hits
}
