/**
 * light-test.ts — the whole engine over the light transport, against a real
 * relay: a LIGHT peer (no GossipSub, pick/push only) and a GOSSIPSUB peer meet
 * on a topic, complete EH-2 both ways through the relay, and exchange
 * ratcheted messages in both directions. `room.ts` is untouched; if this
 * passes, every layer above the transport did not notice the swap.
 *
 *   node net/light-test.ts <relay multiaddr>        # relay started with --pick
 *
 * Exit 0 = both sides secured AND a message each way. Run it against a local
 * relay before a node, and against each node after `--pick` is on there.
 */
import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { createPeer, dial } from './peer.ts'
import { createLightPeer } from './light.ts'
import { randomBytes } from 'node:crypto'

const addr = process.argv[2]
if (!addr) { console.error('usage: node net/light-test.ts <relay multiaddr>'); process.exit(2) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(100) }
  return true
}

const P = { networkId: 'test', dateUTC: '2026-09-24' }
const topic = 'light-' + randomBytes(12).toString('hex')
const macKey = await announceMacKey(randomBytes(32), P)
const [ikL, ikG] = [await generateX25519(), await generateX25519()]

const refused: string[] = []
const light = await createLightPeer({ onRefused: (t) => refused.push(t) })
const gossip = await createPeer()
await dial(light, addr)
await dial(gossip, addr)
console.log(`light  ${light.peerId.toString().slice(0, 12)}... (no gossipsub)\ngossip ${gossip.peerId.toString().slice(0, 12)}...`)

const gotByLight: string[] = [], gotByGossip: string[] = []
const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub, attemptTimeoutMs: 3000 })
const L = joinChat(light, topic, { macKey, eh2: eh2(ikL, ikG.pub) }, { onMessage: (_f, m) => gotByLight.push(m.body) })
const G = joinChat(gossip, topic, { macKey, eh2: eh2(ikG, ikL.pub) }, { onMessage: (_f, m) => gotByGossip.push(m.body) })

const secured = await until(() => L.secured().length > 0 && G.secured().length > 0, 30_000)
console.log(`EH-2 przez light+pick  : ${secured ? 'TAK' : 'NIE'} (light widzi ${L.secured().length}, gossip widzi ${G.secured().length})`)
let l2g = false, g2l = false
if (secured) {
  L.sendText('od lekkiego')
  G.sendText('od gossipa')
  l2g = await until(() => gotByGossip.includes('od lekkiego'), 15_000)
  g2l = await until(() => gotByLight.includes('od gossipa'), 15_000)
}
console.log(`light -> gossip        : ${l2g ? 'TAK' : 'NIE'}`)
console.log(`gossip -> light        : ${g2l ? 'TAK' : 'NIE'}`)
console.log(`odmowy                 : ${refused.length}`)
const ok = secured && l2g && g2l && refused.length === 0
console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
L.stop(); G.stop()
await light.stop(); await gossip.stop()
process.exit(ok ? 0 : 1)
