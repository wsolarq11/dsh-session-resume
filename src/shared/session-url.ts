/**
 * Shared parsing for official session-log download URLs. The official client
 * builds `/api/session.export?sessionId=...&includeDescendants=true`, so this
 * parser intentionally accepts a host-less path as well as an absolute URL.
 */

export interface LogUrlHit {
  id: string
  start: number
  end: number
}

/**
 * URL-token scanner for official session-log download URLs. The token regex
 * is deliberately global-free: a shared `g` flag would carry `lastIndex`
 * state across calls, so `findLogUrlMatches` builds its own instance and the
 * single-match path never touches a module-level cursor.
 */
const URL_TOKEN = /(?:https?:\/\/[^\s()<>]+|\/api\/session\.export[^\s()<>]*)/i

/** Trailing punctuation that closes a token in prose (never part of the URL). */
const URL_TOKEN_TAIL = /[)\]}>"'）】』》…，。；、！？：]/u

function trimUrlToken(raw: string): string {
  let end = raw.length
  while (end > 0 && URL_TOKEN_TAIL.test(raw[end - 1])) {
    end -= 1
  }
  return raw.slice(0, end)
}

export function parseLogUrl(raw: string, start: number): LogUrlHit | null {
  let url: URL
  try {
    url = new URL(raw, 'http://dsh.local')
  } catch {
    return null
  }
  if (url.pathname !== '/api/session.export') return null
  const id = url.searchParams.get('sessionId')
  if (!id) return null
  return { id, start, end: start + raw.length }
}

export function findLogUrlMatches(text: string): LogUrlHit[] {
  const hits: LogUrlHit[] = []
  const re = new RegExp(URL_TOKEN.source, URL_TOKEN.flags + 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    const raw = trimUrlToken(match[0])
    if (!raw) continue
    const hit = parseLogUrl(raw, match.index)
    if (hit) hits.push(hit)
  }
  return hits
}
