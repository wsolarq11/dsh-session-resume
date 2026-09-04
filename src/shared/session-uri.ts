/**
 * Canonical session URI encoding matching `@deepseek-ai/dsh-session-reference`.
 *
 * The official encoding is `dsh-session:<base64url(JSON.stringify(sessionId))>`
 * over UTF-8 bytes. A plain `btoa(JSON.stringify(id))` is not safe for
 * non-Latin-1 session ids, so this module converts UTF-8 bytes explicitly.
 */

export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

function encodeBytes(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function decodeBytes(payload: string): Uint8Array {
  const padded =
    payload.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (payload.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function encodeSessionUri(sessionId: string): string {
  return SESSION_REFERENCE_SCHEME + encodeBytes(JSON.stringify(sessionId))
}

export function decodeSessionPayload(payload: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBytes(payload)))
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function decodeSessionUri(uri: string): string | null {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) return null
  return decodeSessionPayload(uri.slice(SESSION_REFERENCE_SCHEME.length))
}

export function escapeLabel(label: string): string {
  return String(label).replace(/[\\\]]/g, (char) => '\\' + char)
}

export function formatMention(sessionId: string, label: string): string {
  return `@[${escapeLabel(label)}](${encodeSessionUri(sessionId)})`
}
