/**
 * The invite-QR window when several people scan one code (web/src/invqr.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invQrView } from '../web/src/invqr.ts'

const kasia = { name: 'Kasia', pub: 'k' }
const tomek = { name: 'Tomek', pub: 't' }

test('nobody yet: the code, waiting', () => {
  const v = invQrView(0, [], false)
  assert.equal(v.showCode, true)
  assert.equal(v.success, false)
  assert.equal(v.openTarget, null)
})

test('two people scanned: the code stays while either is waiting', () => {
  assert.equal(invQrView(2, [], false).showCode, true)
  // One accepted, the other still waiting: NOT the result yet.
  const v = invQrView(1, [kasia], false)
  assert.equal(v.showCode, true)
  assert.equal(v.success, false)
})

test('both accepted: the result names both, and opens the last one', () => {
  const v = invQrView(0, [kasia, tomek], false)
  assert.equal(v.success, true)
  assert.equal(v.showCode, false)
  assert.deepEqual(v.accepted.map((p) => p.name), ['Kasia', 'Tomek'])
  assert.equal(v.openTarget?.name, 'Tomek')
})

test('"show the code for the next person" brings the code back over the result', () => {
  const v = invQrView(0, [kasia], true)
  assert.equal(v.showCode, true)
  assert.equal(v.success, false)
  assert.deepEqual(v.accepted.map((p) => p.name), ['Kasia'], 'who was accepted is not forgotten')
})

test('the view does not share the caller\'s array', () => {
  const acc = [kasia]
  const v = invQrView(0, acc, false)
  acc.push(tomek)
  assert.equal(v.accepted.length, 1)
})
