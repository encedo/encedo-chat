/**
 * mqtt-meet.ts — two peers meet, handshake and talk over an MQTT broker.
 *
 *   node net/mqtt-meet.ts [mqtt://127.0.0.1:1883]
 *
 * The point is not MQTT: it is that NOTHING above the transport changed. Same
 * rendezvous, same Announce, same EH-2 handshake, same ratchet, same room — only
 * the object the room publishes through is different. If this passes, the
 * fall-back transport is real.
 */

import { createMqttPeer } from './mqtt-node.ts'
import { joinChat } from '../lib/room.ts'
import { announceMacKey, topicFromSecret } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'

const URL = process.argv[2] ?? 'mqtt://127.0.0.1:1883'
const P = { networkId: 'mqtt-test', dateUTC: new Date().toISOString().slice(0, 10) }
const LOG = process.env.LOG === '1'

const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const [ikA, ikB] = [await generateX25519(), await generateX25519()]
const ss = await ikA.dh(ikB.pub)
const topic = await topicFromSecret(ss, P)
const macKey = await announceMacKey(ss, P)
console.log(`broker ${URL}\ntopic  ${topic.slice(0, 24)}…`)

const nodeA = await createMqttPeer({ url: URL, onLog: LOG ? (m) => console.log('  A:', m) : undefined })
const nodeB = await createMqttPeer({ url: URL, onLog: LOG ? (m) => console.log('  B:', m) : undefined })
console.log(`A ${nodeA.peerId.toString()}\nB ${nodeB.peerId.toString()}`)

const got: string[] = []
const back: string[] = []
const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub })
const A = joinChat(nodeA, topic, { macKey, eh2: eh2(ikA, ikB.pub) }, {
  firstAnnounceMs: 100, onMessage: (_f, m) => back.push(m.body),
  onLog: LOG ? (m: string) => console.log('  A:', m) : undefined,
})
const B = joinChat(nodeB, topic, { macKey, eh2: eh2(ikB, ikA.pub) }, {
  firstAnnounceMs: 100, onMessage: (_f, m) => got.push(m.body),
  onLog: LOG ? (m: string) => console.log('  B:', m) : undefined,
})

const t0 = Date.now()
await until(() => A.who().length > 0 && B.who().length > 0, 15_000, 'the two peers see each other')
console.log(`✔ discovered each other in ${Date.now() - t0} ms`)

await until(() => A.secured().length === 1 && B.secured().length === 1, 20_000, 'EH-2 completes')
console.log(`✔ EH-2 established in ${Date.now() - t0} ms (ratchet live on both sides)`)

A.sendText('cześć po MQTT')
await until(() => got.length === 1, 10_000, 'A→B arrives')
B.sendText('i z powrotem')
await until(() => back.length === 1, 10_000, 'B→A arrives')
console.log(`✔ messages both ways, ratchet-sealed: "${got[0]}" / "${back[0]}"`)

A.stop(); B.stop()
await nodeA.stop(); await nodeB.stop()
console.log('\nPASS — the engine runs unchanged over MQTT')
process.exit(0)
