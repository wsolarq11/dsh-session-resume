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

const URL_TOKEN =
  /(?:https?:\/\/[^\s()<>]+|\/api\/session\.export[^\s()<>]*)/gi

function trimUrlToken(raw: string): string {
  let end = raw.length
  while (end > 0 && /[)\]}>"'）】』》…，。；、！？：]/u.test(raw[end - 1])) {
    end -= 1
  }
  return raw.slice(0, end)
}

export function parseLogUrl(raw: string, start: number): LogUrlHit | null {
  const queryIndex = raw.indexOf('?')
  if (queryIndex === -1) return null
  const params = new URLSearchParams(raw.slice(queryIndex + 1))
  const id = params.get('sessionId')
  if (!id) return null
  return { id, start, end: start + raw.length }
}

export function findLogUrlMatch(text: string): LogUrlHit | null {
  URL_TOKEN.lastIndex = 0
  const match = URL_TOKEN.exec(text)
  if (!match || match[0].length === 0) return null
  const raw = trimUrlToken(match[0])
  if (!raw) return null
  return parseLogUrl(raw, match.index)
}

export function findLogUrlMatches(text: string): LogUrlHit[] {
  const hits: LogUrlHit[] = []
  const re = new RegExp(URL_TOKEN.source, URL_TOKEN.flags)
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

export function countDistinctLogSessions(text: string): number {
  return new Set(findLogUrlMatches(text).map((hit) => hit.id)).size
}
