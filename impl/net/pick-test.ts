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
 *   node net/pick-test.ts <relay multiaddr>        # expects per-peer cap 1
 */
import { multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import { pushable } from 'it-pushable'
import { randomBytes } from 'node:crypto'
import { createPeer } from './peer.ts'
import { PROTOCOL, T, encodePick, decodeFrame } from '../../relay/pick.mjs'

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
const fromRight = !!d && d.from === talker.peerId.toString()

// Second pick past the cap -> must be REFUSED, not silent.
out.push(encodePick(second))
for (let i = 0; i < 20; i++) {
  if (got.some((f) => f.type === T.REFUSED)) break
  await sleep(250)
}
const refused = got.some((f) => f.type === T.REFUSED && f.topic === second)

console.log(`dostarczono przez pick : ${delivered ? 'TAK' : 'NIE'}`)
console.log(`from = nadawca         : ${fromRight ? 'TAK' : 'NIE'}${d ? '' : ' (brak ramki)'}`)
console.log(`drugi pick REFUSED     : ${refused ? 'TAK' : 'NIE'}`)
console.log(delivered && fromRight && refused ? 'PRZESZLO' : 'NIE PRZESZLO')

out.end()
await talker.stop(); await picker.stop()
process.exit(delivered && fromRight && refused ? 0 : 1)
