/**
 * pick-test.ts — does a client that only PICKS a topic receive what a GossipSub
 * peer publishes on it, with the sender's id intact?
 *
 * The receive half of the light-client plan (relay/pick.mjs). One peer joins
 * the topic the old way and publishes; another opens `/onchato/pick/1`, says
 * PICK, subscribes to nothing, and must get a DELIVER frame whose `from` is the
 * publisher's id -- because lib/room.ts keys sessions by that id, a delivery
 * attributed to the relay would be worse than none.
 *
 * Then the refusal: with the relay started with `--max-topics-per-peer 1`,
 * a second PICK must come back REFUSED rather than vanish. That answer is the
 * point of the protocol: a GossipSub subscription past the cap gets no signal.
 *
 * Then the send side (phase C): the picker PUSHes an origin-wrapped frame on
 * the topic. The GossipSub talker must receive those bytes untouched (the
 * transport says the relay sent them; the envelope says who did), a second
 * picker must get them as a DELIVER, and the pusher must get an ACK whose
 * reach counts both.
 *
 *   node net/pick-test.ts <relay multiaddr>                  # expects per-peer cap 1
 *   EXPECT_REFUSED=0 node net/pick-test.ts <relay multiaddr>  # production: cap is 40, so no refusal
 */
import { multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import { pushable } from 'it-pushable'
import { randomBytes } from 'node:crypto'
import { createPeer } from './peer.ts'
import { PROTOCOL, T, encodePick, encodePush, decodeFrame } from '../../relay/pick.mjs'
import { wrap, unwrap } from '../lib/origin.ts'

const addr = process.argv[2]
if (!addr) { console.error('usage: node net/pick-test.ts <relay multiaddr>'); process.exit(2) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const talker = await createPeer()   // publishes the old way
const picker = await createPeer()   // receives the new way
await talker.dial(multiaddr(addr))
await picker.dial(multiaddr(addr))

const topic = 'pick-' + randomBytes(8).toString('hex')
const second = 'pick-' + randomBytes(8).toString('hex')

// The picker's stream: frames out through a pushable, frames in through a loop.
const stream = await picker.dialProtocol(multiaddr(addr), PROTOCOL)
const out = pushable<Uint8Array>()
void pipe(out, (s) => lp.encode(s), stream.sink)
const got: any[] = []
void pipe(stream.source, (s) => lp.decode(s), async (src) => {
  for await (const chunk of src) {
    const f = decodeFrame(chunk.subarray())
    if (f) got.push(f)
  }
})

out.push(encodePick(topic))
talker.services.pubsub.subscribe(topic)
await sleep(3000) // relay subscribes, meshes with the talker

const token = 'pick-hello-' + randomBytes(4).toString('hex')
await talker.services.pubsub.publish(topic, new TextEncoder().encode(token))
for (let i = 0; i < 40; i++) {
  if (got.some((f) => f.type === T.DELIVER)) break
  await sleep(250)
}

const d = got.find((f) => f.type === T.DELIVER)
const delivered = !!d && new TextDecoder().decode(d.data) === token
const pickedYes = got.some((f) => f.type === T.PICKED && f.topic === topic)
const fromRight = !!d && d.from === talker.peerId.toString()

// --- the send side: PUSH -------------------------------------------------
// A second picker on the same topic, so the relay has a local holder to
// deliver to besides the GossipSub talker.
const watcher = await createPeer()
await watcher.dial(multiaddr(addr))
const wstream = await watcher.dialProtocol(multiaddr(addr), PROTOCOL)
const wout = pushable<Uint8Array>()
void pipe(wout, (s) => lp.encode(s), wstream.sink)
const wgot: any[] = []
void pipe(wstream.source, (s) => lp.decode(s), async (src) => {
  for await (const chunk of src) { const f = decodeFrame(chunk.subarray()); if (f) wgot.push(f) }
})
wout.push(encodePick(topic))
const talkerGot: Uint8Array[] = []
talker.services.pubsub.addEventListener('message', (e: any) => { if (e.detail.topic === topic) talkerGot.push(e.detail.data) })
await sleep(2000)

const pushToken = 'push-hello-' + randomBytes(4).toString('hex')
const pushed = wrap(picker.peerId.toString(), new TextEncoder().encode(pushToken))
out.push(encodePush(topic, pushed))
for (let i = 0; i < 40; i++) {
  if (got.some((f) => f.type === T.ACK) && talkerGot.length && wgot.some((f) => f.type === T.DELIVER)) break
  await sleep(250)
}
const ack = got.find((f) => f.type === T.ACK && f.topic === topic)
const talkerSaw = talkerGot.some((d) => unwrap(d)?.from === picker.peerId.toString() && new TextDecoder().decode(unwrap(d)!.frame) === pushToken)
const wd = wgot.find((f) => f.type === T.DELIVER)
const watcherSaw = !!wd && unwrap(wd.data)?.from === picker.peerId.toString() && new TextDecoder().decode(unwrap(wd.data)!.frame) === pushToken
const pusherEcho = got.some((f) => f.type === T.DELIVER && f.topic === topic && unwrap(f.data)?.from === picker.peerId.toString())

// Second pick past the cap -> must be REFUSED, not silent.
out.push(encodePick(second))
for (let i = 0; i < 20; i++) {
  if (got.some((f) => f.type === T.REFUSED)) break
  await sleep(250)
}
const refused = got.some((f) => f.type === T.REFUSED && f.topic === second)
const pickedNo = !got.some((f) => f.type === T.PICKED && f.topic === second)
// On production the per-peer cap is 40, so a second pick is rightly accepted;
// the refusal path is proven against a local relay started with cap 1.
const expectRefused = process.env.EXPECT_REFUSED !== '0'
const refusalOk = expectRefused ? refused : !refused

console.log(`PICK -> PICKED         : ${pickedYes ? 'TAK' : 'NIE'}`)
console.log(`dostarczono przez pick : ${delivered ? 'TAK' : 'NIE'}`)
console.log(`from = nadawca         : ${fromRight ? 'TAK' : 'NIE'}${d ? '' : ' (brak ramki)'}`)
console.log(`drugi pick REFUSED     : ${refused ? 'TAK' : 'NIE'}${expectRefused ? '' : ' (oczekiwane NIE: limit 40)'}`)
console.log(`PUSH -> ACK            : ${ack ? `TAK (reach ${ack.recipients})` : 'NIE'}`)
console.log(`PUSH -> gossipsub peer : ${talkerSaw ? 'TAK (bajty i koperta nietkniete)' : 'NIE'}`)
console.log(`PUSH -> drugi picker   : ${watcherSaw ? 'TAK (DELIVER, from z koperty = pusher)' : 'NIE'}`)
console.log(`PUSH nie wraca do pushera: ${pusherEcho ? 'NIE (echo!)' : 'TAK'}`)
const pushOk = !!ack && ack.recipients >= 2 && talkerSaw && watcherSaw && !pusherEcho
// A refused pick must not ALSO be answered PICKED (whatever the cap under test, a
// PICKED for the first topic is required).
const pickedOk = pickedYes && (!refused || pickedNo)
const ok = delivered && fromRight && refusalOk && pushOk && pickedOk
console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')

out.end(); wout.end()
await talker.stop(); await picker.stop(); await watcher.stop()
process.exit(ok ? 0 : 1)
