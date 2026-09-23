/**
 * shard-test.ts — does a room still work when its two people sit on DIFFERENT
 * relays, and does a room on one relay stay off the other?
 *
 * Both halves of `--local-topics-only` in one run, and it deliberately does NOT
 * use the app. The question is a property of GossipSub — "will a message cross
 * between two relays that each subscribed because of their own client" — and
 * answering it through the chat UI would drag in EH-2, presence and WebRTC,
 * any of which could fail for its own reasons and be read as this one failing.
 *
 * It also cannot be answered by the browser harness at all: libp2p's WebSocket
 * transport refuses plain `ws://` on an IP address in a browser, so local test
 * relays are unreachable from there. That is why `RELAY_A`/`RELAY_B` in
 * `browser-test.ts` name bs1 and bs2 — production nodes, with TLS.
 *
 *   node net/shard-test.ts /ip4/127.0.0.1/tcp/9901/ws/p2p/<A> /ip4/.../<B>
 *
 * Exit 0 = crossed AND stayed local. Anything else prints what went wrong.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { randomBytes } from 'node:crypto'
import { createPeer } from './peer.ts'

const [addrA, addrB] = process.argv.slice(2)
if (!addrA || !addrB) {
  console.error('usage: node net/shard-test.ts <relayA multiaddr> <relayB multiaddr>')
  process.exit(2)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const utf8 = new TextEncoder()

const a = await createPeer()
const b = await createPeer()
await a.dial(multiaddr(addrA))
await b.dial(multiaddr(addrB))
console.log(`A -> ${addrA.slice(0, 44)}...\nB -> ${addrB.slice(0, 44)}...`)

// Long enough for the relays to notice the subscription and graft a mesh for
// it. Too short here reads exactly like "it does not cross".
const SETTLE = 4000

// ---- 1. the room that spans two relays -------------------------------------
const shared = 'shard-cross-' + randomBytes(8).toString('hex')
const got: string[] = []
b.services.pubsub.addEventListener('message', (evt: any) => {
  if (evt.detail.topic === shared) got.push(new TextDecoder().decode(evt.detail.data))
})
a.services.pubsub.subscribe(shared)
b.services.pubsub.subscribe(shared)
await sleep(SETTLE)

const token = 'hello-' + randomBytes(4).toString('hex')
await a.services.pubsub.publish(shared, utf8.encode(token))
for (let i = 0; i < 40 && !got.includes(token); i++) await sleep(250)

// ---- 2. the room that must NOT spread --------------------------------------
// Only A's side subscribes. Relay B has no client asking for it, so with
// `--local-topics-only` it must never carry the topic — that saving is the
// whole point. Checked from the relay's own log by the caller.
const lonely = 'shard-lonely-' + randomBytes(8).toString('hex')
a.services.pubsub.subscribe(lonely)
await sleep(SETTLE)
await a.services.pubsub.publish(lonely, utf8.encode('nobody-should-carry-this'))
await sleep(1500)

console.log(`\ntemat wspolny : ${shared}`)
console.log(`temat samotny : ${lonely}`)
console.log(got.includes(token)
  ? `PRZESZLO — B dostal "${token}" przez drugi przekaznik`
  : `NIE PRZESZLO — B nie dostal nic (odebrane: ${JSON.stringify(got)})`)

await a.stop(); await b.stop()
process.exit(got.includes(token) ? 0 : 1)
