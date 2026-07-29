/**
 * EH-2 stage 4 — Double Ratchet (docs/PROTOCOL.md §7).
 *
 * The properties that matter: both sides stay in step across hundreds of
 * messages and direction changes; a late message still opens; a message key is
 * used exactly once (per-message forward secrecy — a state that has moved on
 * cannot go back); and the skipped-key bounds hold, because they are what stops
 * a peer from making us derive unbounded keys.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ratchetFrom, RatchetError, type Ratchet } from '../eh2/ratchet.ts'
import { initiate, initiatorComplete, respond, responderComplete } from '../eh2/handshake.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { mlkem768 } from '../eh2/mlkem.ts'

const NOW = 1_784_000_000_000
const te = new TextEncoder()
const td = new TextDecoder()

/** A real handshake, then both ratchets. */
async function pair(opts: Parameters<typeof ratchetFrom>[1] = {}): Promise<{ I: Ratchet; R: Ratchet }> {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem: mlkem768, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem: mlkem768, now: NOW })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  return { I: await ratchetFrom(i2.result, opts), R: await ratchetFrom(rr, opts) }
}

const say = async (from: Ratchet, to: Ratchet, text: string) => {
  const opened = await to.decrypt(await from.encrypt(te.encode(text)))
  return opened === null ? null : td.decode(opened)
}

test('the initiator can send immediately after the handshake', async () => {
  const { I, R } = await pair()
  assert.equal(await say(I, R, 'cześć 👋'), 'cześć 👋')
})

test('100 messages each way, with the direction turning', async () => {
  const { I, R } = await pair()
  for (let i = 0; i < 100; i++) {
    assert.equal(await say(I, R, `i-${i}`), `i-${i}`)
    assert.equal(await say(R, I, `r-${i}`), `r-${i}`)
  }
  // ping-pong means a DH step every turn; long runs in one direction too:
  for (let i = 0; i < 50; i++) assert.equal(await say(I, R, `burst-${i}`), `burst-${i}`)
  assert.equal(await say(R, I, 'still here'), 'still here')
})

test('the DH ratchet actually turns: the sender key changes with the direction', async () => {
  const { I, R } = await pair()
  const iKey1 = I.stats().dhPub
  assert.equal(R.stats().dhPub, null, 'the responder has no ratchet key until it sends')
  await say(I, R, 'a')
  await say(R, I, 'b')
  const rKey1 = R.stats().dhPub
  assert.ok(rKey1, 'the responder generated one on its first send')
  await say(I, R, 'c')
  assert.notEqual(I.stats().dhPub, iKey1, 'the initiator re-keys after receiving a new peer key')
  await say(R, I, 'd')
  assert.notEqual(R.stats().dhPub, rKey1)
})

test('out-of-order delivery: later messages open, then the gaps fill in', async () => {
  const { I, R } = await pair()
  const frames = []
  for (let i = 0; i < 5; i++) frames.push(await I.encrypt(te.encode(`m${i}`)))

  assert.equal(td.decode((await R.decrypt(frames[4]))!), 'm4')
  assert.equal(R.stats().skipped, 4, 'the four skipped keys are held')
  assert.equal(td.decode((await R.decrypt(frames[0]))!), 'm0')
  assert.equal(td.decode((await R.decrypt(frames[2]))!), 'm2')
  assert.equal(td.decode((await R.decrypt(frames[1]))!), 'm1')
  assert.equal(td.decode((await R.decrypt(frames[3]))!), 'm3')
  assert.equal(R.stats().skipped, 0, 'all consumed')
})

test('messages from a previous chain still open after the direction turned', async () => {
  const { I, R } = await pair()
  const late = await I.encrypt(te.encode('sent before the turn'))
  await say(I, R, 'arrives first')            // R receives on chain 1
  await say(R, I, 'R replies')                // R opens a new chain
  await say(I, R, 'I replies')                // I steps; R closes chain 1 (pn)
  assert.equal(td.decode((await R.decrypt(late))!), 'sent before the turn')
})

test('per-message forward secrecy: a consumed message key is gone', async () => {
  const { I, R } = await pair()
  const frame = await I.encrypt(te.encode('once'))
  assert.equal(td.decode((await R.decrypt(frame))!), 'once')
  assert.equal(await R.decrypt(frame), null, 'replay of the same frame fails — the key was erased')
  for (let i = 0; i < 5; i++) await say(I, R, `next-${i}`)
  assert.equal(await R.decrypt(frame), null, 'and it stays unreadable as the chain advances')
})

test('tampering and foreign frames are rejected, never thrown at the caller', async () => {
  const { I, R } = await pair()
  const frame = await I.encrypt(te.encode('authentic'))

  const flipCt = frame.slice(); flipCt[frame.length - 1] ^= 0x01
  assert.equal(await R.decrypt(flipCt), null, 'ciphertext tamper → AEAD tag fails')

  const flipHdr = frame.slice(); flipHdr[41] ^= 0x01 // message counter, part of the AAD
  assert.equal(await R.decrypt(flipHdr), null, 'header tamper → AAD mismatch')

  assert.equal(await R.decrypt(te.encode('not a ratchet frame at all')), null)
  assert.equal(await R.decrypt(new Uint8Array(0)), null)

  const { I: other } = await pair()
  assert.equal(await R.decrypt(await other.encrypt(te.encode('wrong session'))), null)

  // the untampered original still opens
  assert.equal(td.decode((await R.decrypt(frame))!), 'authentic')
})

test('a forged frame cannot desync the conversation (state moves only on success)', async () => {
  const { I, R } = await pair()
  assert.equal(await say(I, R, 'before'), 'before')

  // A frame from a different session: its header carries an unknown ratchet
  // key, so opening it would mean stepping our root. It must not.
  const { I: stranger } = await pair()
  assert.equal(await R.decrypt(await stranger.encrypt(te.encode('forged'))), null)
  // And a same-chain forgery must not burn the pending message key either.
  const tampered = await I.encrypt(te.encode('will be mangled'))
  tampered[tampered.length - 1] ^= 0x80
  assert.equal(await R.decrypt(tampered), null)

  assert.equal(await say(I, R, 'after'), 'after')
  assert.equal(await say(R, I, 'reply'), 'reply')
  assert.equal(await say(I, R, 'and on'), 'and on')
})

test('skipped-key bound: a peer cannot make us derive unbounded keys (§7.3)', async () => {
  const { I, R } = await pair({ maxSkipPerChain: 10 })
  for (let i = 0; i < 12; i++) await I.encrypt(te.encode(`skip-${i}`))
  const far = await I.encrypt(te.encode('way ahead'))
  await assert.rejects(() => R.decrypt(far), (e: Error) => e instanceof RatchetError && /bound/.test(e.message))
})

test('old chains and stale keys are dropped (5 chains back, TTL)', async () => {
  let clock = NOW
  const { I, R } = await pair({ maxChainsBack: 2, skippedTtlMs: 60_000, now: () => clock })

  // three chains, each leaving one un-delivered message behind
  for (let round = 0; round < 3; round++) {
    const orphan = await I.encrypt(te.encode(`orphan-${round}`))
    await say(I, R, `delivered-${round}`)
    await say(R, I, `turn-${round}`)
    assert.ok(orphan.length > 0)
  }
  assert.ok(R.stats().skipped <= 2, `only the 2 most recent chains are kept, got ${R.stats().skipped}`)

  // and what is kept expires (still 2 chains: the newest one evicts the oldest)
  const stale = await I.encrypt(te.encode('stale'))
  await say(I, R, 'newer')
  assert.equal(R.stats().skipped, 2)
  clock += 61_000
  assert.equal(await R.decrypt(stale), null, 'past its TTL the key is gone')
  assert.equal(R.stats().skipped, 0)
})
