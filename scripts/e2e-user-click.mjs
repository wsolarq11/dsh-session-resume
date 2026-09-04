/**
 * Digital "real user click" E2E over the live typert protocol.
 *
 * A real one-click resume drives: resolvePlan (which materializes a new
 * snapshot on disk) -> create/reuse target session -> report 'accepted' to the
 * Host (WAL). That is exactly the host-side mutation a real GUI click causes.
 *
 * This runner performs those steps over the real typert gateway (/api/sessionResume/*,
 * pure protocol) against a real session that exists on disk, and asserts the
 * DIGITAL observable deltas a real click leaves behind:
 *   1. a NEW snapshot directory appears for the source session (materialization),
 *   2. a NEW 'accepted' order lands in the WAL with that attemptId + a real targetSessionId.
 * Any assertion failure exits non-zero (auto-converge, no manual judgement).
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const BASE = 'http://127.0.0.1:3080'
const CACHE = join(process.env.TEMP || os.tmpdir(), 'dsh-session-resume')
const WAL = join(CACHE, 'orders.jsonl')
const SOURCE_SESSION = process.env.SOURCE_SESSION_ID || 'session-334c2edd-8922-40e6-9d19-eb8b62931fa8'

let pass = 0
let fail = 0
const ok = (label) => { pass += 1; console.log(' PASS', label) }
const bad = (label, e) => { fail += 1; console.log(' FAIL', label, String(e && e.message || e).slice(0, 200)) }

async function rpc(method, args) {
  const r = await fetch(`${BASE}/api/sessionResume/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'clk', method: `sessionResume/${method}`, payload: { args } }),
  })
  const result = (await r.json()).result
  // The gateway returns { ok, value } where `value` is the business result
  // (itself {ok:true,...}) on success, or {ok:false,error} on a business failure.
  return result.ok ? result.value : result
}

function snapshotDir(sessionId) {
  return join(CACHE, sessionId, 'snapshots')
}
function snapshotMaxSeq(sessionId) {
  const dir = snapshotDir(sessionId)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).reduce((max, n) => (/^\d+$/.test(n) ? Math.max(max, Number(n)) : max), 0)
}
function walAcceptedIds() {
  if (!existsSync(WAL)) return new Set()
  return new Set(
    readFileSync(WAL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((o) => o && o.status === 'accepted')
      .map((o) => o.attemptId),
  )
}

async function main() {
  const attemptId = `click-${randomUUID().slice(0, 8)}`
  const beforeSnapMax = snapshotMaxSeq(SOURCE_SESSION)
  const beforeAccepted = walAcceptedIds()
  try {
    // 1. resolveLogPath (a real click on the source materializes a NEW snapshot on disk)
    const rs = await rpc('resolveLogPath', { sessionId: SOURCE_SESSION })
    if (!rs?.ok || !rs.path) throw new Error('resolveLogPath !ok')
    const afterMax = snapshotMaxSeq(SOURCE_SESSION)
    if (afterMax !== beforeSnapMax + 1) {
      throw new Error(`snapshot not materialized on disk: maxSeq ${beforeSnapMax} -> ${afterMax}`)
    }
    ok(`click materialized NEW snapshot ${beforeSnapMax} -> ${afterMax}: ${rs.path}`)

    // 2. resolvePlan (real click resolves the plan over the protocol)
    const plan = await rpc('resolvePlan', { sessionId: SOURCE_SESSION, attemptId, snapshotId: '' })
    if (!plan || !plan.ok) throw new Error(`plan !ok: ${JSON.stringify(plan)}`)
    ok(`resolvePlan over protocol for attempt ${attemptId}`)

    // 3. completeResume -> accepted terminal + a fresh WAL order (digital)
    const targetSessionId = SOURCE_SESSION // reuse path used by real clicks
    const comp = await rpc('completeResume', { attemptId, status: 'accepted', targetSessionId, error: '' })
    const afterAccepted = walAcceptedIds()
    if (!comp || !comp.ok || comp.status !== 'accepted') throw new Error('completeResume !accepted')
    if (!afterAccepted.has(attemptId)) throw new Error(`WAL missing accepted attempt ${attemptId}`)
    ok(`completeResume accepted + WAL order recorded: ${attemptId} -> ${targetSessionId}`)

    // 4. idempotent: replay complete -> fails closed (already terminal)
    const comp2 = await rpc('completeResume', { attemptId, status: 'failed', targetSessionId: '', error: 'x' })
    if (!(comp2.ok === false && /已处于/.test(comp2.error))) throw new Error('terminal invariance not enforced')
    ok('terminal invariance (re-complete rejected)')

    console.log(`\nGATE-USER-CLICK: pass=${pass} fail=${fail}`)
    if (fail > 0) process.exitCode = 1
  } catch (e) {
    console.log(`\nGATE-USER-CLICK: pass=${pass} fail=1 reason=${String(e && e.stack || e).slice(0, 300)}`)
    process.exitCode = 2
  }
}

main().catch((e) => { console.error(e); process.exitCode = 3 })