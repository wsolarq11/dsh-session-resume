/**
 * Legacy session-surface detection.
 *
 * The engine's resume path reads an official `dsh-session:` mention through
 * `dsh-session-query.readSurface`, which validates every surface message via
 * `snapshotSessionEvent` -> `assertMessageEventShape`: a message event whose
 * carrier lacks a non-empty string `id` is rejected with "lacks an identified
 * message". The plugin's materialized snapshot directory is read through the
 * persistence path that first upgrades legacy rows, so it never trips that
 * validation.
 *
 * The durable, reinstall-proof fix is therefore to route a source whose raw log
 * carries such an un-identified message event through the snapshot path
 * reference instead of an engine `dsh-session:` mention, which would re-trigger
 * the fragile surface read and fail resume.
 *
 * This module is the single source of truth for "does this source break the
 * mention read", mirroring `assertMessageEventShape`'s id requirement exactly.
 * It is pure (no I/O) so the Host detection and the wire flag share one shape.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasId(message: unknown): boolean {
  return isRecord(message) && typeof message.id === 'string' && message.id !== ''
}

/**
 * Whether one message-carrying event lacks an identified message, i.e. would
 * fail `assertMessageEventShape` and thus the engine's fragile surface read.
 * Mirrors the engine rule per event type.
 */
export function isUnidentifiedMessageEvent(event: unknown): boolean {
  if (!isRecord(event) || !isRecord(event.data) || typeof event.seq !== 'number') return false
  const data = event.data
  switch (event.type) {
    case 'user/message':
      // The user message IS the data carrier, so it must carry a string id.
      return !hasId(data)
    case 'assistant/message':
    case 'tool/result':
      return !hasId(data.message)
    default:
      return false
  }
}

/** Whether a raw artifact exposes any message event missing its identity. */
export function hasLegacySurfaceEvents(content: string): boolean {
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      // A torn/unparsable line is not legacy evidence; ignore it like the
      // engine's tolerant raw readers do.
      continue
    }
    if (isUnidentifiedMessageEvent(event)) return true
  }
  return false
}