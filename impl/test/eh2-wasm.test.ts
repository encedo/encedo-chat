/**
 * eh2-wasm.test.ts - core-rs behind the EH-2 seam (eh2/wasm.ts).
 *
 * The Rust crate reproduces the known-answer vectors in its own tests
 * (core-rs/tests/kat.rs); what is pinned here is the seam: the module loads,
 * a WASM pair handshakes and ratchets, and - the property that matters for a
 * mixed fleet - a TS engine and a WASM engine open each other's frames in
 * both roles, through a hybrid step, out of order, and refuse what they must.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCore, startHandshakeWasm } from '../eh2/wasm.ts'
import { startHandshake, setCoreBackend, coreBackend, type Eh2Handshake, type StartOpts } from '../eh2/establish.ts'
import { x25519FromPriv, type Dh } from '../lib/x25519.ts'
import type { Session } from '../lib/session.ts'

const te = new TextEncoder(), td = new TextDecoder()
const fill = (v: number) => new Uint8Array(32).fill(v)
const TAG = fill(0x7a)

async function pair(): Promise<{ ikI: Dh; ikR: Dh }> {
  return { ikI: await x25519FromPriv(fill(0x11)), ikR: await x25519FromPriv(fill(0x22)) }
}
type Engine = 'ts' | 'wasm'
async function start(engine: Engine, opts: StartOpts): Promise<Eh2Handshake> {
  return engine === 'wasm' ? startHandshakeWasm(opts) : startHandshake(opts)
}
/** Run the three frames between two engines; returns both sessions. */
async function establish(eI: Engine, eR: Engine, ratchet = { pqEverySteps: 1 }): Promise<{ I: Session; R: Session; hi: Eh2Handshake; hr: Eh2Handshake }> {
  const { ikI, ikR } = await pair()
  const hi = await start(eI, { role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: TAG, ratchet })
  const hr = await start(eR, { role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG, ratchet })
  const msg2 = (await hr.feed(hi.initial[0]))!
  assert.equal(hr.authenticated, false, 'R must not trust I before msg3')
  const msg3 = (await hi.feed(msg2))!
  assert.equal(hi.authenticated, true)
  assert.equal(await hr.feed(msg3), null)
  assert.equal(hr.authenticated, true)
  return { I: await hi.session, R: await hr.session, hi, hr }
}
async function say(from: Session, to: Session, text: string): Promise<void> {
  const f = await from.encrypt(te.encode(text))
  const pt = await to.decrypt(f)
  assert.ok(pt, `${text} did not open`)
  assert.equal(td.decode(pt!), text)
}

test('the module loads and speaks wire version 3', async () => {
  const core = await loadCore()
  assert.equal(core.version, 3)
})

test('two WASM engines handshake and ratchet, hybrid steps included', async () => {
  const { I, R } = await establish('wasm', 'wasm')
  for (const [who, text] of [['I', 'a'], ['R', 'b'], ['I', 'c'], ['R', 'd'], ['I', 'e'], ['R', 'f']] as const) {
    await (who === 'I' ? say(I, R, text) : say(R, I, text))
  }
  const sI = (I as any).stats(), sR = (R as any).stats()
  assert.ok(sI.pqSteps >= 1 && sR.pqSteps >= 1, `both roots took an ML-KEM secret (I ${sI.pqSteps}, R ${sR.pqSteps})`)
  assert.equal(sI.pqSteps, sR.pqSteps)
})

for (const [eI, eR] of [['ts', 'wasm'], ['wasm', 'ts']] as const) {
  test(`${eI} initiator <-> ${eR} responder: the same wire, through a hybrid step, out of order`, async () => {
    const { I, R } = await establish(eI, eR)
    await say(I, R, 'hello from ' + eI)
    await say(R, I, 'hello from ' + eR)
    await say(I, R, 'again')      // a hybrid step crosses engines here (K = 1)
    await say(R, I, 'and back')
    // Out of order: three frames, delivered 3, 1, 2 - the skipped keys are held and used.
    const f1 = await I.encrypt(te.encode('one')), f2 = await I.encrypt(te.encode('two')), f3 = await I.encrypt(te.encode('three'))
    assert.equal(td.decode((await R.decrypt(f3))!), 'three')
    assert.equal(td.decode((await R.decrypt(f1))!), 'one')
    assert.equal(td.decode((await R.decrypt(f2))!), 'two')
    assert.equal(await R.decrypt(f2), null, 'a replay of a spent key opens nothing')
    await say(R, I, 'turn')
    await say(I, R, 'turn again')
    const sI = (I as any).stats?.() ?? null, sR = (R as any).stats?.() ?? null
    if (sI && sR) assert.equal(sI.pqSteps, sR.pqSteps)
  })
}

test('a tampered frame opens nothing and burns nothing; a wrong tag and a second window are named', async () => {
  const { I, R } = await establish('wasm', 'wasm')
  const f = await I.encrypt(te.encode('x'))
  const bad = f.slice(); bad[bad.length - 1] ^= 1
  assert.equal(await R.decrypt(bad), null)
  assert.equal(td.decode((await R.decrypt(f))!), 'x', 'the chain was untouched by the forgery')

  const { ikI, ikR } = await pair()
  const stranger = await x25519FromPriv(fill(0x99))
  const hs = await startHandshakeWasm({ role: 'initiator', ik: stranger, peerIkPub: ikR.pub, tagKey: TAG })
  const hr = await startHandshakeWasm({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
  await assert.rejects(hr.feed(hs.initial[0]), /does not match the contact/)
  const second = await startHandshakeWasm({ role: 'initiator', ik: ikR, peerIkPub: ikR.pub, tagKey: TAG })
  const hr2 = await startHandshakeWasm({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
  await assert.rejects(hr2.feed(second.initial[0]), /second window/)
})

test('a flipped byte in msg2 fails mac_r on a WASM initiator, and the session never resolves', async () => {
  const { ikI, ikR } = await pair()
  const hi = await startHandshakeWasm({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: TAG })
  const hr = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
  const msg2 = (await hr.feed(hi.initial[0]))!
  msg2[40] ^= 1 // inside pq_ct: the transcript no longer matches mac_r
  await assert.rejects(hi.feed(msg2), /mac_r/)
  await assert.rejects(hi.session)
})

test('the process-wide switch routes startHandshake to the module', async () => {
  assert.equal(coreBackend(), 'ts')
  setCoreBackend('wasm')
  try {
    const { ikI, ikR } = await pair()
    const hi = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: TAG })
    const hr = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
    const msg2 = (await hr.feed(hi.initial[0]))!
    const msg3 = (await hi.feed(msg2))!
    await hr.feed(msg3)
    const I = await hi.session, R = await hr.session
    assert.ok(typeof (I as any).stats === 'function' && typeof (R as any).stats === 'function', 'both sessions came from the module')
    await say(I, R, 'routed')
  } finally { setCoreBackend('ts') }
})
