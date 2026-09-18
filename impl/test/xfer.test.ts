import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSender, createReceiver, openOffer, decodeOffer, isXfer, receiptEvery,
  encodeChunk, encodeOffer, newId, CHUNK, DC_MAX_MESSAGE, MAX_DIRECT, MAX_OFFER_BODY,
  ACCEPT_MS, STALL_MS, T, CTRL,
} from '../lib/xfer.ts'

test('a full chunk frame fits the message ceiling a peer that advertises no max-message-size imposes', () => {
  // The bug this pins: a 64 KiB body made the frame 65546 bytes, ten past the
  // 65536 a browser assumes for such a peer (webrtc-rs), so the browser refused
  // to send it and every Tauri<->Chromium transfer died at the first chunk.
  const frame = encodeChunk(newId(), 0, new Uint8Array(CHUNK))
  assert.equal(frame.length, DC_MAX_MESSAGE, 'a full chunk frame should be exactly the ceiling')
})

const file = (size: number, name = 'raport.pdf') => ({ name, size, mime: 'application/pdf' })
const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i + seed) & 0xff)

/** Drive a whole transfer between two machines, no channel in between. */
function run(size: number, opts: { skipAccept?: boolean } = {}) {
  const s = createSender(file(size))
  let now = 1000
  const offerFrame = s.open(now)
  const opened = openOffer(offerFrame)
  assert.ok(opened && 'offer' in opened, 'offer refused')
  const r = createReceiver(opened.offer)
  const evsS: any[] = [], evsR: any[] = []
  if (!opts.skipAccept) evsS.push(...s.onFrame(r.accept(now), now))

  let receipts = 0
  for (let guard = 0; guard < 100_000; guard++) {
    const i = s.next()
    if (i === null) break
    const start = i * CHUNK
    const body = bytes(Math.min(CHUNK, size - start), i)
    const out = r.onFrame(s.chunk(i, body), ++now)
    evsR.push(...out.evs)
    if (out.reply) {
      if (out.reply[1] === T.RECEIPT) receipts++
      evsS.push(...s.onFrame(out.reply, now))
    }
  }
  return { s, r, evsS, evsR, receipts }
}

test('a whole file arrives, in order, byte for byte', () => {
  const size = CHUNK * 3 + 777
  const { s, r, evsS } = run(size)
  assert.equal(s.state, 'done')
  assert.equal(r.state, 'done')
  assert.equal(r.received(), size)
  const joined = new Uint8Array(size)
  let at = 0
  for (const p of r.parts()) { joined.set(p, at); at += p.length }
  // Every chunk was numbered from its own index, so a swapped pair shows here.
  for (let i = 0; i < 4; i++) {
    const start = i * CHUNK
    const want = bytes(Math.min(CHUNK, size - start), i)
    assert.deepEqual([...joined.subarray(start, start + want.length)], [...want], `chunk ${i}`)
  }
  assert.ok(evsS.some((e) => e.t === 'done'))
})

test('receipts stay between 50 and 100, whatever the size', () => {
  // The cadence is the contract: both sides derive it from the offer alone, so
  // nothing is negotiated and nothing drifts. `ceil` puts the count under a
  // hundred rather than on it — 250 chunks means every third, so 83 — and the
  // floor is what matters for the progress bar: never worse than every 2%.
  assert.equal(receiptEvery(1), 1)
  assert.equal(receiptEvery(80), 1)
  assert.equal(receiptEvery(1280), 13)
  for (const chunks of [101, 199, 200, 250, 1280, 8192]) {
    const n = Math.floor(chunks / receiptEvery(chunks))
    assert.ok(n >= 50 && n <= 100, `${chunks} chunks -> ${n} receipts`)
  }
  const { receipts } = run(CHUNK * 250)
  assert.equal(receipts, 83)
})

test('the last chunk is confirmed by DONE, not by a receipt', () => {
  const { s, r } = run(CHUNK * 2)
  assert.equal(s.state, 'done')
  assert.equal(r.state, 'done')
})

test('a single short file still works', () => {
  const { s, r } = run(10)
  assert.equal(r.received(), 10)
  assert.equal(s.state, 'done')
})

test('nobody answers: the offer times out and says so once', () => {
  const s = createSender(file(1000))
  s.open(0)
  assert.deepEqual(s.tick(ACCEPT_MS - 1), [])
  assert.deepEqual(s.tick(ACCEPT_MS + 1), [{ t: 'failed', why: 'timeout' }])
  assert.equal(s.state, 'failed')
})

test('the receiver says no', () => {
  const s = createSender(file(1000))
  const r = createReceiver((openOffer(s.open(0)) as any).offer)
  assert.deepEqual(s.onFrame(r.reject(), 1), [{ t: 'failed', why: 'rejected' }])
})

test('either side can cancel mid-file, and the other hears it', () => {
  for (const who of ['sender', 'receiver'] as const) {
    const s = createSender(file(CHUNK * 4))
    const r = createReceiver((openOffer(s.open(0)) as any).offer)
    s.onFrame(r.accept(0), 0)
    r.onFrame(s.chunk(0, bytes(CHUNK)), 1)
    if (who === 'sender') {
      const evs = r.onFrame(s.cancel(), 2).evs
      assert.deepEqual(evs, [{ t: 'failed', why: 'cancelled-peer' }])
      assert.equal(s.state, 'failed')
    } else {
      assert.deepEqual(s.onFrame(r.cancel(), 2), [{ t: 'failed', why: 'cancelled-peer' }])
      assert.equal(r.state, 'failed')
    }
  }
})

test('silence mid-transfer is a failure, not a wait forever', () => {
  // The channel can die without an onclose — a crashed tab on the other side
  // looks exactly like a very slow one until this timer says otherwise.
  const s = createSender(file(CHUNK * 4))
  const r = createReceiver((openOffer(s.open(0)) as any).offer)
  s.onFrame(r.accept(0), 0)
  assert.deepEqual(s.tick(STALL_MS + 1), [{ t: 'failed', why: 'channel' }])
  assert.deepEqual(r.tick(STALL_MS + 1), [{ t: 'failed', why: 'channel' }])
})

test('a gap in the order fails loudly instead of writing a broken file', () => {
  const s = createSender(file(CHUNK * 3))
  const r = createReceiver((openOffer(s.open(0)) as any).offer)
  s.onFrame(r.accept(0), 0)
  r.onFrame(s.chunk(0, bytes(CHUNK)), 1)
  const out = r.onFrame(s.chunk(2, bytes(CHUNK)), 2)   // 1 skipped
  assert.deepEqual(out.evs, [{ t: 'failed', why: 'out-of-order' }])
})

test('a chunk of the wrong length is refused', () => {
  const s = createSender(file(CHUNK * 2))
  const r = createReceiver((openOffer(s.open(0)) as any).offer)
  s.onFrame(r.accept(0), 0)
  const out = r.onFrame(s.chunk(0, bytes(CHUNK - 5)), 1)
  assert.deepEqual(out.evs, [{ t: 'failed', why: 'bad-frame' }])
})

test('too big, and empty, are refused before anybody is asked', () => {
  const big = createSender(file(MAX_DIRECT + 1))
  assert.deepEqual(openOffer(big.open(0)), { why: 'too-big' })
  const none = createSender(file(0))
  assert.deepEqual(openOffer(none.open(0)), { why: 'empty' })
})

test('an offer whose geometry does not add up is not an offer', () => {
  const s = createSender(file(CHUNK * 2))
  const f = s.open(0)
  const j = JSON.parse(new TextDecoder().decode(f.subarray(6)))
  const forge = (o: any) => {
    const body = new TextEncoder().encode(JSON.stringify(o))
    const out = new Uint8Array(6 + body.length)
    out.set(f.subarray(0, 6)); out.set(body, 6)
    return out
  }
  assert.equal(decodeOffer(forge({ ...j, chunks: j.chunks + 1 })), null)
  assert.equal(decodeOffer(forge({ ...j, chunk: 1234 })), null)
  assert.equal(decodeOffer(forge({ ...j, size: -1 })), null)
})

test('frames from another transfer are ignored, not fatal', () => {
  // Both sides can still have a frame in flight when one ends; treating a
  // stale id as an error would kill the transfer that replaced it.
  const s = createSender(file(CHUNK), 111)
  const other = createReceiver({ ...s.offer, id: 222 })
  s.onFrame(other.accept(0), 0)
  assert.equal(s.state, 'offering')
  assert.deepEqual(s.onFrame(other.cancel(), 1), [])
})

test('the channel keeps its own ping and pong', () => {
  // 0x00 0x50 / 0x00 0x4f belong to net/webrtc.ts. If this module ever claimed
  // them, the channel would stop proving itself and every transfer would start
  // on a link nobody verified.
  assert.equal(isXfer(new Uint8Array([CTRL, 0x50])), false)
  assert.equal(isXfer(new Uint8Array([CTRL, 0x4f])), false)
  assert.equal(isXfer(new Uint8Array([0x10, T.OFFER, 0, 0, 0, 0])), false)
  assert.equal(isXfer(new Uint8Array([CTRL, T.CHUNK, 0, 0, 0, 0])), true)
})

// ---- the note that travels with the file ----------------------------------

test('a note typed with the file crosses inside the offer', () => {
  const s = createSender({ ...file(3 * CHUNK), body: 'to ten raport, o ktory prosilas' })
  const opened = openOffer(s.open(1000))
  assert.ok(opened && 'offer' in opened)
  assert.equal(opened.offer.body, 'to ten raport, o ktory prosilas')
})

test('no note means no field on the wire, not an empty one', () => {
  // The common case has to put exactly the bytes there that 0.6.3 put there,
  // or every transfer to an older peer would be testing new code for nothing.
  const frame = createSender(file(CHUNK)).open(1000)
  const json = JSON.parse(new TextDecoder().decode(frame.subarray(6)))
  assert.equal('body' in json, false, 'a captionless offer should carry no body key')
})

test('an offer from a peer that never heard of notes is still an offer', () => {
  // Exactly the JSON 0.6.3 emitted, byte for byte.
  const id = newId()
  const size = 2 * CHUNK
  const body = new TextEncoder().encode(JSON.stringify(
    { name: 'stary.pdf', size, mime: 'application/pdf', chunk: CHUNK, chunks: 2 }))
  const frame = new Uint8Array(6 + body.length)
  frame[0] = CTRL; frame[1] = T.OFFER
  new DataView(frame.buffer).setUint32(2, id)
  frame.set(body, 6)
  const o = decodeOffer(frame)
  assert.ok(o, 'an offer without a note must still decode')
  assert.equal(o.body, undefined)
  assert.equal(o.name, 'stary.pdf')
})

test('a note at the ceiling still builds a frame the channel will carry', () => {
  // Worst case on purpose: control characters, which JSON escapes to six bytes
  // each. A note that passes the check must not be able to push the offer past
  // the ceiling — that is the 2026-09-14 failure shape, one frame too large and
  // every transfer dying as a dead channel.
  let note = ''
  while (new TextEncoder().encode(JSON.stringify(note + '\u0001')).length <= MAX_OFFER_BODY) note += '\u0001'
  const frame = encodeOffer({
    id: newId(), name: 'x'.repeat(200), size: MAX_DIRECT,
    mime: 'y'.repeat(100), chunk: CHUNK, chunks: Math.ceil(MAX_DIRECT / CHUNK), body: note,
  })
  assert.ok(frame.length < DC_MAX_MESSAGE, `offer frame ${frame.length} must stay under ${DC_MAX_MESSAGE}`)
})

test('a note longer than the ceiling is cut when read, never trusted whole', () => {
  const id = newId()
  const size = CHUNK
  const huge = 'z'.repeat(MAX_OFFER_BODY * 3)
  const body = new TextEncoder().encode(JSON.stringify(
    { name: 'a.bin', size, mime: 'application/octet-stream', chunk: CHUNK, chunks: 1, body: huge }))
  const frame = new Uint8Array(6 + body.length)
  frame[0] = CTRL; frame[1] = T.OFFER
  new DataView(frame.buffer).setUint32(2, id)
  frame.set(body, 6)
  const o = decodeOffer(frame)
  assert.ok(o)
  assert.equal(o.body?.length, MAX_OFFER_BODY, 'a peer must not be able to hand us an unbounded note')
})
