/**
 * eh2-chat-test.ts — live integration: two peers meet in the deterministic room
 * via the onchato relay, run the **EH-2 handshake over the room**, and exchange
 * a message sealed by the Double Ratchet. Exits 0 on success.
 *   node net/eh2-chat-test.ts
 *
 * Same shape as chat-test.ts, one difference that is the whole point: no shared
 * static key. Content is readable only after msg1→msg2→msg3 have crossed the
 * real network and both sides hold a ratchet.
 */

import { multiaddr } from '@multiformats/multiaddr'
import { randomBytes } from 'node:crypto'
import { topicFromSecret, announceMacKey } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { joinChat } from '../lib/room.ts'
import { createPeer } from './peer.ts'
import { onchatoRelay } from './onchato.ts'

const [ikA, ikB] = [await generateX25519(), await generateX25519()]
// Rendezvous still comes from the pair secret (§5); only content crypto changed.
const ss = await ikA.dh(ikB.pub)
const p = { networkId: 'test', dateUTC: '2026-01-01' }
const topic = await topicFromSecret(ss, p)
const macKey = await announceMacKey(ss, p)
const SECRET = 'eh2-ping-' + randomBytes(4).toString('hex')

const { multiaddr: relay } = await onchatoRelay()
const na = await createPeer()
const nb = await createPeer()
await Promise.all([na.dial(multiaddr(relay)), nb.dial(multiaddr(relay))])
console.log(`dialed onchato relay; topic=${topic.slice(0, 14)}…  sending "${SECRET}" under EH-2`)

const state = (who: string) => (peer: string, s: string) => console.log(`  ${who}: EH-2 ${s} with ${peer.slice(0, 12)}…`)

let ra: any, rb: any
const received = new Promise<string>((resolve) => {
  rb = joinChat(nb, topic, { macKey, eh2: { ik: ikB, peerIkPub: ikA.pub, onState: state('B') } }, {
    onMessage: (_from, m) => resolve(m.body),
  })
  ra = joinChat(na, topic, { macKey, eh2: { ik: ikA, peerIkPub: ikB.pub, onState: state('A') } }, {})
})
const sender = setInterval(() => ra.sendText(SECRET), 3000) // resend until the mesh forms
const got = await Promise.race([received, new Promise<null>((r) => setTimeout(() => r(null), 60_000))])

const secured = { a: ra.secured(), b: rb.secured() }
clearInterval(sender)
ra.stop(); rb.stop()
await Promise.allSettled([na.stop(), nb.stop()])

if (got === SECRET && secured.a.length === 1 && secured.b.length === 1) {
  console.log(`PASS — handshake completed over the relay and B decrypted A's ratcheted message: "${got}"`)
  process.exit(0)
}
console.log(`FAIL — got ${JSON.stringify(got)}, expected ${SECRET}; secured A=${secured.a.length} B=${secured.b.length}`)
process.exit(1)
