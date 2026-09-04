/**
 * Live API smoke test against a running DSH web instance.
 *
 * Requires the plugin to be injected and DSH web on http://127.0.0.1:3080.
 * Verifies the loopback JSON envelope, the config GET/PUT round-trip, the
 * snapshots listing, and the batch-resume guard. Exits non-zero on any
 * mismatch so CI can gate on it.
 */

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const API = `${BASE}/session-resume/api`

async function jsonFetch(path, init) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  return { status: response.status, body: await response.json() }
}

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`)
  process.exitCode = 1
}

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail(name)
}

// 1. GET /config returns the loopback envelope with a config object.
let result = await jsonFetch('/config')
check(
  'GET /config envelope',
  result.status === 200 && result.body.ok === true && typeof result.body.config === 'object',
  `status=${result.status}`,
)
const originalInstruction =
  result.body.config?.resumeInstruction
check(
  'GET /config instruction non-empty',
  typeof originalInstruction === 'string' && originalInstruction.trim().length > 0,
)

// 2. PUT /config round-trip preserves a custom instruction and returns it.
const custom = '只总结已完成工作，不继续执行'
result = await jsonFetch('/config', {
  method: 'PUT',
  body: JSON.stringify({ resumeInstruction: custom }),
})
check(
  'PUT /config returns saved config',
  result.status === 200 && result.body.ok === true && result.body.config.resumeInstruction === custom,
  JSON.stringify(result.body.config),
)
result = await jsonFetch('/config')
check(
  'GET /config echoes saved instruction',
  result.body.config?.resumeInstruction === custom,
)

// 3. PUT /config with a bad body fails closed (400).
result = await jsonFetch('/config', { method: 'PUT', body: '{not json' })
check('PUT /config invalid JSON rejected', result.status === 400 && result.body.ok === false)

// 4. GET /snapshots for an unknown session returns an empty list.
result = await jsonFetch('/snapshots?sessionId=smoke_no_such_session')
check(
  'GET /snapshots unknown session',
  result.status === 200 && result.body.ok === true && Array.isArray(result.body.snapshots),
  `count=${result.body.snapshots?.length}`,
)

// 5. POST /resume-batch with no sessions is rejected.
result = await jsonFetch('/resume-batch', { method: 'POST', body: JSON.stringify({ sessionIds: [] }) })
check(
  'POST /resume-batch empty rejected',
  result.status === 400 && result.body.ok === false,
  result.body.error,
)

// 6. Unknown route stays 404.
result = await jsonFetch('/no-such-route')
check('unknown route 404', result.status === 404 && result.body.ok === false)

// Restore the default instruction so the smoke run leaves config untouched.
result = await jsonFetch('/config', {
  method: 'PUT',
  body: JSON.stringify({ resumeInstruction: originalInstruction }),
})
check('PUT /config restores default', result.status === 200 && result.body.ok === true)

console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED')
process.exit(process.exitCode ?? 0)
