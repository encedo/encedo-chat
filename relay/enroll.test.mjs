import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { makeEnroll, totpAt, enrollMessage, statusMessage, toBase32, fromBase32, ed25519OfPeerId, LOCK_AFTER, PER_IP_FAILURES, STEP_S } from './enroll.mjs'
import { peerIdFromString } from '@libp2p/peer-id'
import { parseAllowlist } from './allowlist.mjs'

test('TOTP: RFC 6238 appendix B, SHA-1, 8 digits', () => {
  const key = Buffer.from('12345678901234567890')
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totpAt(key, Math.floor(t / STEP_S)), want, `t=${t}`)
  }
  assert.deepEqual(fromBase32(toBase32(key)), key)
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'enroll-')), listFile = join(dir, 'peers.txt')
  const seed = Buffer.from('0123456789abcdefghij')
  writeFileSync(join(dir, 'totp.seed'), toBase32(seed) + '\n')
  let t = 1_800_000_000_000
  const e = makeEnroll({ networkId: 'acme', listFile, now: () => t, log: () => {} })
  const key = await generateKeyPair('Ed25519'), peerId = peerIdFromPrivateKey(key).toString()
  const code = () => totpAt(seed, Math.floor(t / 1000 / STEP_S))
  const attempt = async (c, k = key, id = peerId, ip = '1.2.3.4', label) => {
    const { nonce } = e.challenge()
    const sig = Buffer.from(await k.sign(enrollMessage('acme', nonce, c))).toString('base64')
    return e.enroll({ peerId: id, nonce, code: c, sig, label }, ip)
  }
  return { dir, listFile, e, key, peerId, code, attempt, tick: (ms) => { t += ms } }
}

test('a device with the right code and its own key goes onto the list, and asks about itself', async () => {
  const s = await setup()
  try {
    const r = await s.attempt(s.code(), s.key, s.peerId, '1.2.3.4', 'Jan <phone>#1')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const text = readFileSync(s.listFile, 'utf8')
    assert.ok(parseAllowlist(text).ids.has(s.peerId))
    assert.ok(!text.includes('<') && !text.includes('#1'), 'the label was not cleaned')
    const { nonce } = s.e.challenge()
    const sig = Buffer.from(await s.key.sign(statusMessage('acme', nonce))).toString('base64')
    assert.deepEqual((await s.e.status({ peerId: s.peerId, nonce, sig })).body, { listed: true, locked: false })
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
})

test('refused: a challenge used twice, a code used twice, another key, another network, a wrong code', async () => {
  const s = await setup()
  try {
    const { nonce } = s.e.challenge()
    const c = s.code()
    const sig = Buffer.from(await s.key.sign(enrollMessage('acme', nonce, c))).toString('base64')
    assert.equal((await s.e.enroll({ peerId: s.peerId, nonce, code: c, sig })).status, 200)
    assert.equal((await s.e.enroll({ peerId: s.peerId, nonce, code: c, sig })).body.error, 'challenge', 'a challenge worked twice')
    const other = await generateKeyPair('Ed25519'), otherId = peerIdFromPrivateKey(other).toString()
    assert.equal((await s.attempt(c, other, otherId)).body.error, 'code', 'a code worked twice')
    s.tick(STEP_S * 1000 * 3)
    assert.equal((await s.attempt(s.code(), other, s.peerId)).body.error, 'signature', 'someone else\'s PeerId was enrolled')
    const { nonce: n2 } = s.e.challenge()
    const sig2 = Buffer.from(await other.sign(enrollMessage('other-net', n2, s.code()))).toString('base64')
    assert.equal((await s.e.enroll({ peerId: otherId, nonce: n2, code: s.code(), sig: sig2 })).body.error, 'signature', 'a signature for another network was accepted')
    assert.equal((await s.attempt('00000000', other, otherId)).body.error, 'code')
    assert.ok(!parseAllowlist(readFileSync(s.listFile, 'utf8')).ids.has(otherId))
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
})

test('guessing: an address is slowed after a few wrong codes; the network locks after many, until unlocked', async () => {
  const s = await setup()
  try {
    for (let i = 0; i < PER_IP_FAILURES; i++) assert.equal((await s.attempt('11111111', s.key, s.peerId, '9.9.9.9')).status, 403)
    assert.equal((await s.attempt(s.code(), s.key, s.peerId, '9.9.9.9')).status, 429, 'the address was not slowed down')
    for (let i = 0; existsSync(join(s.dir, 'enroll.locked')) === false && i < LOCK_AFTER; i++) await s.attempt('22222222', s.key, s.peerId, `10.0.0.${i}`)
    assert.ok(existsSync(join(s.dir, 'enroll.locked')), `not locked after ${LOCK_AFTER} wrong codes`)
    assert.equal((await s.attempt(s.code(), s.key, s.peerId, '5.5.5.5')).status, 423, 'a locked network enrolled a device')
    unlinkSync(join(s.dir, 'enroll.locked')); unlinkSync(join(s.dir, 'enroll.failures'))
    assert.equal((await s.attempt(s.code(), s.key, s.peerId, '5.5.5.5')).status, 200, 'unlocking did not reopen enrolment')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
})

test('the key read out of a PeerId is the one libp2p reads; anything else is no key', async () => {
  for (let i = 0; i < 20; i++) {
    const k = await generateKeyPair('Ed25519'), id = peerIdFromPrivateKey(k).toString()
    assert.deepEqual(new Uint8Array(ed25519OfPeerId(id)), peerIdFromString(id).publicKey.raw, id)
  }
  assert.equal(ed25519OfPeerId('QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N'), null, 'an RSA/sha256 PeerId is not an Ed25519 key')
  assert.equal(ed25519OfPeerId('12D3KooW0OIl'), null)
})
