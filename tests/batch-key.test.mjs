import test from 'node:test'
import assert from 'node:assert/strict'
import { batchOrderKey } from '../lib/orchestration/client/batch.js'

test('batchOrderKey cannot collide for session ids containing the old separator', () => {
  assert.notEqual(batchOrderKey(['a|b', 'c']), batchOrderKey(['a', 'b|c']))
  assert.equal(batchOrderKey(['a', 'b']), batchOrderKey(['a', 'b']))
})

test('batchOrderKey is order-insensitive so reordering the same set does not resubmit', () => {
  assert.equal(batchOrderKey(['sess_a', 'sess_b']), batchOrderKey(['sess_b', 'sess_a']))
  assert.notEqual(batchOrderKey(['sess_a']), batchOrderKey(['sess_a', 'sess_a']))
})
