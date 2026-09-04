import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress } from '../lib/host/api.js'
import { isSafeOrderId } from '../lib/host/resume-order.js'

test('loopback check fails closed when remote address is missing', () => {
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isLoopbackAddress(''), false)
})

test('loopback check accepts only explicit loopback addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.2'), false)
})

test('order ids are bounded and use a safe character set', () => {
  assert.equal(isSafeOrderId('attempt_123-abc'), true)
  assert.equal(isSafeOrderId(''), false)
  assert.equal(isSafeOrderId('../escape'), false)
  assert.equal(isSafeOrderId('a'.repeat(129)), false)
})
