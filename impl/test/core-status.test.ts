/**
 * core-status.test.ts - which engine a handshake actually ran on (eh2/establish.ts).
 *
 * `coreBackend()` names the engine that was ASKED for until the first
 * handshake falls back, so it cannot tell a shell whose host core answered
 * from one whose keys quietly came back into the page. `coreStatus()` and
 * `onCoreFallback` can; Diagnostyka and the connection diary read them.
 * Node has no Tauri host, so asking for 'native' here is exactly the shell
 * whose host does not answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHandshake, setCoreBackend, coreStatus, onCoreFallback } from '../eh2/establish.ts'
import { x25519FromPriv } from '../lib/x25519.ts'

const fill = (v: number) => new Uint8Array(32).fill(v)

async function oneHandshakeStart() {
  const ikI = await x25519FromPriv(fill(0x11)), ikR = await x25519FromPriv(fill(0x22))
  return startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: fill(0x7a) })
}

test('before any handshake the status says what was asked, and that nothing ran yet', () => {
  setCoreBackend('native')
  try {
    assert.deepEqual(coreStatus(), { asked: 'native', used: null, fallbacks: [] })
  } finally { setCoreBackend('ts') }
})

test('a host that does not answer is recorded, reported once, and the handshake runs on WASM', async () => {
  const told: string[] = []
  setCoreBackend('native')
  onCoreFallback((f) => told.push(`${f.from}->${f.to}`))
  try {
    const h = await oneHandshakeStart()
    assert.ok(h.initial[0]?.length, 'the fallback still produced a msg1')
    const s = coreStatus()
    assert.equal(s.asked, 'native')
    assert.equal(s.used, 'wasm', 'the keys are in the page now, and the status must say so')
    assert.deepEqual(s.fallbacks.map((f) => `${f.from}->${f.to}`), ['native->wasm'])
    assert.ok(s.fallbacks[0].reason.length > 0, 'the reason is kept for Diagnostyka')
    assert.deepEqual(told, ['native->wasm'])
    await oneHandshakeStart()
    assert.deepEqual(told, ['native->wasm'], 'a second handshake does not report the same fallback again')
  } finally { onCoreFallback(null); setCoreBackend('ts') }
})

test('an engine that was asked for and ran records no fallback', async () => {
  setCoreBackend('wasm')
  try {
    await oneHandshakeStart()
    assert.deepEqual(coreStatus(), { asked: 'wasm', used: 'wasm', fallbacks: [] })
  } finally { setCoreBackend('ts') }
})

test('a reset of the switch clears the record', async () => {
  setCoreBackend('native')
  await oneHandshakeStart()
  setCoreBackend('ts')
  assert.deepEqual(coreStatus(), { asked: 'ts', used: null, fallbacks: [] })
})
