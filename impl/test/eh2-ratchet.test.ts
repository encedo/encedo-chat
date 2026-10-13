/**
 * EH-2 stage 4 — Double Ratchet (docs/SPEC.md §7).
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
import { mlkem768, mlkem768Seeded, MLKEM768_SEED } from '../eh2/mlkem.ts'
import { x25519FromPriv } from '../lib/x25519.ts'
import { readFileSync } from 'node:fs'
/** k_tag stand-in (§6.1): the room derives it from the pair's Announce key; these tests hand it in. */
const TAG_KEY = new Uint8Array(32).fill(0x7a)

const NOW = 1_784_000_000_000
const te = new TextEncoder()
const td = new TextDecoder()

/** A real handshake, then both ratchets (`optsR` lets the two sides differ, e.g. in their hybrid cadence). */
async function pair(opts: Parameters<typeof ratchetFrom>[1] = {}, optsR = opts): Promise<{ I: Ratchet; R: Ratchet }> {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const i1 = await initiate({ tagKey: TAG_KEY, ik: ikI, peerIkPub: ikR.pub, kem: mlkem768, now: NOW })
  const r1 = await respond({ tagKey: TAG_KEY, ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem: mlkem768, now: NOW })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  return { I: await ratchetFrom(i2.result, opts), R: await ratchetFrom(rr, optsR) }
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

test('sends fired in the same tick do not collide (the ratchet serialises itself)', async () => {
  // Callers do not await: the room sends content with `void emitContent(...)`,
  // so an ack for an incoming message races the typing notice, and a flush of
  // pending messages races itself. Without serialisation both calls read the
  // same chain key, stamp the same `n`, and then both advance the chain — the
  // peer opens one frame at most and its receiving chain is behind for good.
  const { I, R } = await pair()
  const bodies = ['jeden', 'dwa', 'trzy', 'cztery', 'pięć']
  const frames = await Promise.all(bodies.map((b) => I.encrypt(te.encode(b))))

  const seen = frames.map((f) => new DataView(f.buffer, f.byteOffset).getUint32(38, false)) // `n` from the header
  assert.equal(new Set(seen).size, frames.length, 'every frame gets its own message number')

  const opened: string[] = []
  for (const f of frames) {
    const pt = await R.decrypt(f)
    assert.ok(pt, 'every frame from a burst must open')
    opened.push(td.decode(pt!))
  }
  assert.deepEqual(opened, bodies)
})

test('receives fired in the same tick do not collide either', async () => {
  // The mirror image: frames arrive from GossipSub and from the DataChannel, and
  // the room feeds both without awaiting.
  const { I, R } = await pair()
  const bodies = ['a', 'b', 'c', 'd']
  const frames: Uint8Array[] = []
  for (const b of bodies) frames.push(await I.encrypt(te.encode(b)))

  const opened = await Promise.all(frames.map((f) => R.decrypt(f)))
  assert.deepEqual(opened.map((p) => (p ? td.decode(p) : null)), bodies)
})

// ---------------------------------------------------------------------------
// the hybrid step (7.2): ML-KEM into the DH ratchet
// ---------------------------------------------------------------------------

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
const isPq = (f: Uint8Array) => f[0] === 0x11
const flagsOf = (f: Uint8Array) => f[42]

test('hybrid: every K-th step issues a key, the peer answers with a ciphertext, and both roots take the secret', async () => {
  const { I, R } = await pair({ pqEverySteps: 2 })
  const frames: Uint8Array[] = []
  const turn = async (from: Ratchet, to: Ratchet, text: string) => {
    const f = await from.encrypt(te.encode(text)); frames.push(f)
    assert.equal(td.decode((await to.decrypt(f))!), text)
  }
  // Each turn is a DH step on the sender; after two steps a key goes out, the
  // peer's next step carries the ciphertext, and both count one hybrid step.
  for (let i = 0; i < 8; i++) await turn(i % 2 ? R : I, i % 2 ? I : R, `t${i}`)
  assert.ok(frames.some((f) => isPq(f) && (flagsOf(f) & 0x02)), 'a frame carried an encapsulation key')
  assert.ok(frames.some((f) => isPq(f) && (flagsOf(f) & 0x01)), 'a frame carried the ciphertext back')
  assert.ok(I.stats().pqSteps >= 1 && R.stats().pqSteps >= 1, `both sides mixed ML-KEM in: I=${I.stats().pqSteps} R=${R.stats().pqSteps}`)
  assert.equal(I.stats().pqSteps, R.stats().pqSteps, 'the same number of hybrid steps on both sides')
  // ...and the conversation goes on, both ways, across it.
  await turn(I, R, 'after'); await turn(R, I, 'and back')
})

test('hybrid: the time cadence issues a key on the next step once T has passed', async () => {
  let t = NOW
  const { I, R } = await pair({ pqEverySteps: 1000, pqEveryMs: 60_000, now: () => t })
  await say(I, R, 'a'); await say(R, I, 'b')
  assert.equal(I.stats().pqOutstanding, false, 'nothing yet: neither K nor T reached')
  t += 61_000
  await say(I, R, 'c')
  assert.equal(I.stats().pqOutstanding, true, 'T passed: the next step carried a key')
  await say(R, I, 'd')
  assert.equal(I.stats().pqOutstanding, false, 'answered on the peer\'s next step')
  assert.equal(I.stats().pqSteps, 1); assert.equal(R.stats().pqSteps, 1)
})

test('hybrid: the key rides every frame until answered, so a lost step frame does not cost the contribution', async () => {
  // Only I issues keys here, so that I's step is classical and carries one.
  const { I, R } = await pair({ pqEverySteps: 1 }, { pqEverySteps: 1000 })
  await say(I, R, 'a'); await say(R, I, 'b')        // I's next send is a step, and K = 1: it issues a key
  const lost = await I.encrypt(te.encode('lost'))    // the step frame, with the key - never delivered
  assert.ok(isPq(lost) && (flagsOf(lost) & 0x02))
  const next = await I.encrypt(te.encode('next'))    // same chain: still carries the key
  assert.ok(isPq(next) && (flagsOf(next) & 0x02), 'the key is on the following frame too')
  assert.equal(td.decode((await R.decrypt(next))!), 'next')
  await say(R, I, 'c')                               // R's next step answers with the ciphertext
  assert.equal(I.stats().pqOutstanding, false)
  assert.equal(I.stats().pqSteps, 1); assert.equal(R.stats().pqSteps, 1)
  await say(I, R, 'd'); await say(R, I, 'e')
})

test('hybrid: the ciphertext rides every frame of the answering chain, so its lost step frame costs nothing either', async () => {
  const { I, R } = await pair({ pqEverySteps: 1 }, { pqEverySteps: 1000 })
  await say(I, R, 'a'); await say(R, I, 'b'); await say(I, R, 'c') // c carried I's key
  const lostAnswer = await R.encrypt(te.encode('lost'))              // R's hybrid step, with the ciphertext - never delivered
  assert.ok(isPq(lostAnswer) && (flagsOf(lostAnswer) & 0x01))
  const next = await R.encrypt(te.encode('next'))
  assert.ok(flagsOf(next) & 0x01, 'the ciphertext is on the following frame too')
  assert.equal(td.decode((await I.decrypt(next))!), 'next', 'I steps into the hybrid root from the second frame')
  assert.equal(I.stats().pqSteps, 1); assert.equal(R.stats().pqSteps, 1)
  await say(I, R, 'd'); await say(R, I, 'e')
})

test('hybrid: a ciphertext under no key of ours, or a header edited in flight, opens nothing and moves nothing', async () => {
  const { I, R } = await pair({ pqEverySteps: 1000 })
  await say(I, R, 'a'); await say(R, I, 'b')
  const good = await I.encrypt(te.encode('c'))
  // A forged "answer": the same frame with a pq_ct bolted on (type 0x11, flags 0x01).
  const forged = new Uint8Array(good.length + 1 + 2 + 1088)
  forged.set(good.subarray(0, 42)); forged[0] = 0x11; forged[42] = 0x01
  new DataView(forged.buffer).setUint16(43, 1088, false); forged.set(good.subarray(42), 45 + 1088)
  assert.equal(await R.decrypt(forged), null)
  const before = R.stats()
  assert.equal(td.decode((await R.decrypt(good))!), 'c', 'the genuine frame still opens: nothing was consumed')
  assert.deepEqual(R.stats().pqSteps, before.pqSteps)
})

test('hybrid: a message key from before the hybrid step stays unreadable after it (forward secrecy across the step)', async () => {
  const { I, R } = await pair({ pqEverySteps: 1 })
  const early = await I.encrypt(te.encode('early'))
  assert.equal(td.decode((await R.decrypt(early))!), 'early')
  for (let i = 0; i < 6; i++) await say(i % 2 ? I : R, i % 2 ? R : I, `t${i}`)
  assert.ok(R.stats().pqSteps >= 1)
  assert.equal(await R.decrypt(early), null)
})

test('KAT: a scripted hybrid exchange with fixed keys matches docs/kat/ratchet-hybrid.json', async () => {
  const KAT = JSON.parse(readFileSync(new URL('../../docs/kat/ratchet-hybrid.json', import.meta.url), 'utf8'))
  const fill = (v: number) => new Uint8Array(32).fill(v)
  const kem = mlkem768Seeded(new Uint8Array(MLKEM768_SEED).fill(0x55), fill(0x66))
  let k = 0x50
  const generateDh = async () => x25519FromPriv(fill(k++))
  const ikI = await x25519FromPriv(fill(0x11)), ikR = await x25519FromPriv(fill(0x22))
  const i1 = await initiate({ tagKey: TAG_KEY, ik: ikI, peerIkPub: ikR.pub, kem, now: NOW, ek: await x25519FromPriv(fill(0x33)) })
  const r1 = await respond({ tagKey: TAG_KEY, ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW, ek: await x25519FromPriv(fill(0x44)) })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  const opts = { kem, generateDh, pqEverySteps: 1, now: () => NOW }
  const I = await ratchetFrom(i2.result, opts), R = await ratchetFrom(rr, opts)
  const frames: string[] = []
  for (const [who, text] of KAT.script as [string, string][]) {
    const [from, to] = who === 'I' ? [I, R] : [R, I]
    const f = await from.encrypt(te.encode(text)); frames.push(hex(f))
    assert.equal(td.decode((await to.decrypt(f))!), text)
  }
  assert.deepEqual(frames, KAT.frames)
  assert.equal(I.stats().pqSteps, KAT.pq_steps); assert.equal(R.stats().pqSteps, KAT.pq_steps)
})
