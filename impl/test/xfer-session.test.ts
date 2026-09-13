import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createXferSession, type XferEv, type Direct } from '../lib/xfer-session.ts'
import { CHUNK, MAX_DIRECT } from '../lib/xfer.ts'

/**
 * A file that slices like the browser's does, WITHOUT allocating itself: the
 * size limit is half a gigabyte and a test that wants to cross it must not
 * spend half a gigabyte doing so.
 */
function fakeFile(size: number, name = 'raport.pdf', type = 'application/pdf') {
  const at = (i: number) => (i * 31) & 0xff
  return {
    name, size, type, at,
    slice(a: number, b: number) {
      return { arrayBuffer: async () => Uint8Array.from({ length: b - a }, (_, i) => at(a + i)).buffer }
    },
  }
}

/**
 * Two sessions wired to each other. Frames cross through a queue rather than a
 * direct call, so nothing depends on one side finishing inside the other's
 * stack — which is exactly how a real channel behaves.
 */
function pair(opts: { drops?: boolean } = {}) {
  const q: Array<() => void> = []
  const evs = { a: [] as XferEv[], b: [] as XferEv[] }
  let live = true
  const chan = (to: () => { onFrame(b: Uint8Array): void }): Direct => ({
    send: (bytes) => { if (live) q.push(() => to().onFrame(bytes)) },
    buffered: () => 0,
    drain: async () => {},
  })
  const A = createXferSession({ direct: () => (live ? chan(() => B) : null) }, (e) => evs.a.push(e))
  const B = createXferSession({ direct: () => (live ? chan(() => A) : null) }, (e) => evs.b.push(e))
  /**
   * Deliver until nothing is moving. Not `while (q.length)`: the sender's pump
   * is async, so between two chunks the queue is legitimately empty while a
   * slice is being read — stopping there would end the test mid-file, which is
   * exactly what the first version of this did.
   */
  const flush = async () => {
    let idle = 0
    for (let i = 0; i < 500_000 && idle < 8; i++) {
      if (q.length) { idle = 0; q.shift()!() }
      else { idle++ }
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { A, B, evs, flush, cut: () => { live = false }, stop: () => { A.stop(); B.stop() } }
}

test('a file crosses, and arrives as the same bytes', async () => {
  const { A, B, evs, flush, stop } = pair()
  const f = fakeFile(CHUNK * 2 + 1234)
  assert.equal(A.offer(f), 'ok')
  await flush()
  assert.deepEqual(evs.b.at(-1), { t: 'offer', name: 'raport.pdf', size: f.size, mime: 'application/pdf' })

  B.accept()
  await flush()
  const got = evs.b.find((e) => e.t === 'received') as any
  assert.ok(got, 'nothing was received')
  assert.equal(got.name, 'raport.pdf')
  assert.equal(got.blob.size, f.size)
  const back = new Uint8Array(await got.blob.arrayBuffer())
  assert.ok(back.every((v, i) => v === f.at(i)), 'the bytes are not the ones that were sent')
  assert.ok(evs.a.some((e) => e.t === 'done'))
  // Both sides are free again the moment it ends.
  assert.equal(A.busy(), false)
  assert.equal(B.busy(), false)
  stop()
})

test('progress is reported on both sides and ends at the full size', async () => {
  const { A, B, evs, flush, stop } = pair()
  const f = fakeFile(CHUNK * 120)          // enough chunks for real receipts
  A.offer(f); await flush(); B.accept(); await flush()
  const out = evs.a.filter((e) => e.t === 'progress') as any[]
  const inc = evs.b.filter((e) => e.t === 'progress') as any[]
  assert.ok(out.length >= 50 && out.length <= 100, `sender saw ${out.length} steps`)
  assert.equal(inc.length, 120)
  assert.equal(inc.at(-1).done, f.size)
  assert.ok(out.every((e) => e.dir === 'out') && inc.every((e) => e.dir === 'in'))
  stop()
})

test('no channel means no offer — never a quiet fallback to the relay', () => {
  const s = createXferSession({ direct: () => null }, () => {})
  assert.equal(s.offer(fakeFile(10)), 'no-channel')
  s.stop()
})

test('one at a time — a second offer is refused while one is in flight', async () => {
  const { A, B, flush, stop } = pair()
  A.offer(fakeFile(CHUNK * 4)); await flush()
  B.accept()                                   // in flight: no flush, nothing finished
  assert.equal(B.offer(fakeFile(100)), 'busy')
  assert.equal(A.offer(fakeFile(100)), 'busy')
  await flush()
  // ...and free again the moment it ends, without anybody clearing anything.
  assert.equal(A.offer(fakeFile(100)), 'ok')
  stop()
})

test('an offer while busy is answered, not ignored', async () => {
  const { A, B, evs, flush, stop } = pair()
  A.offer(fakeFile(CHUNK * 40)); await flush()          // B now holds an offer
  const second = createXferSession({ direct: () => ({ send: (b) => B.onFrame(b), buffered: () => 0, drain: async () => {} }) }, () => {})
  second.offer(fakeFile(CHUNK))
  await flush()
  assert.ok((evs.b.filter((e) => e.t === 'failed') as any[]).some((e) => e.why === 'busy'))
  second.stop(); stop()
})

test('too big is refused before anybody is asked', () => {
  const s = createXferSession({ direct: () => ({ send: () => {}, buffered: () => 0, drain: async () => {} }) }, () => {})
  assert.equal(s.offer(fakeFile(MAX_DIRECT + 1)), 'too-big')
  assert.equal(s.offer(fakeFile(0)), 'empty')
  s.stop()
})

test('the channel dying mid-file fails loudly', async () => {
  const { A, B, evs, flush, cut, stop } = pair()
  A.offer(fakeFile(CHUNK * 200)); await flush()
  B.accept()
  cut()                                   // the link is gone between chunks
  await flush()
  const bad = evs.a.find((e) => e.t === 'failed') as any
  assert.ok(bad, 'the sender never noticed')
  assert.equal(bad.why, 'channel')
  assert.equal(A.busy(), false)
  stop()
})

test('either side can cancel mid-file, and the other hears it', async () => {
  for (const who of ['sender', 'receiver'] as const) {
    const { A, B, evs, flush, stop } = pair()
    A.offer(fakeFile(CHUNK * 60)); await flush()
    B.accept()
    ;(who === 'sender' ? A : B).cancel()      // while it is still running
    await flush()
    assert.equal(A.busy(), false, `${who}: sender still busy`)
    assert.equal(B.busy(), false, `${who}: receiver still busy`)
    const local = (who === 'sender' ? evs.a : evs.b) as any[]
    const peer = (who === 'sender' ? evs.b : evs.a) as any[]
    assert.ok(local.some((e) => e.t === 'failed' && e.why === 'cancelled-local'), `${who}: no local failure`)
    assert.ok(peer.some((e) => e.t === 'failed' && e.why === 'cancelled-peer'), `${who}: peer never heard`)
    stop()
  }
})

test('a refusal reaches the sender as a refusal', async () => {
  const { A, B, evs, flush, stop } = pair()
  A.offer(fakeFile(CHUNK)); await flush()
  B.reject(); await flush()
  assert.deepEqual(evs.a.at(-1), { t: 'failed', dir: 'out', why: 'rejected' })
  assert.equal(A.busy(), false)
  stop()
})
