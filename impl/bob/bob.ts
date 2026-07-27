/**
 * bob.ts — CLI for the software peer "Bob" in the live rendezvous test.
 *
 *   node bob/bob.ts init [--handle bob]        generate Bob's identity, print pubkey
 *   node bob/bob.ts pubkey                      print Bob's pubkey (base64) for HEM import
 *   node bob/bob.ts add-peer <handle> <pubB64>  save a peer's pubkey (e.g. Alice from her HEM)
 *   node bob/bob.ts peers                        list stored peers
 *   node bob/bob.ts topic <peer> [--network m] [--date YYYY-MM-DD]
 *                                                derive the rendezvous topic + announce MAC key
 *
 * Test flow: `init` -> give the printed pubkey to Alice (she imports it into her
 * HEM as ETSEIC:peer,bob,ik) -> `add-peer alice <alice_pub_from_HEM>` -> `topic alice`.
 * Alice runs the same derivation over her HEM; the two topics MUST match.
 */

import { Keystore } from './keystore.ts'
import { topicFromSecret, todayUTC } from '../lib/rendezvous.ts'
import { softwareIdentity } from '../cli/identity.ts'
import { runChatSession } from '../cli/chat-session.ts'
import { onchatoRelay } from '../net/onchato.ts'

const KS_PATH = new URL('./bob.keystore.json', import.meta.url).pathname
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name: string, def?: string): string | undefined => {
  const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def
}

function requireKeystore(): Keystore {
  if (!Keystore.exists(KS_PATH)) { console.error('No keystore — run: node bob/bob.ts init'); process.exit(1) }
  return Keystore.load(KS_PATH)
}

switch (cmd) {
  case 'init': {
    if (Keystore.exists(KS_PATH)) { console.error('Keystore already exists:', KS_PATH); process.exit(1) }
    const ks = Keystore.create(KS_PATH, opt('--handle', 'bob')!)
    console.log(`Bob created — handle "${ks.data.handle}"`)
    console.log(`DESCR:  ${ks.descrSelf()}`)
    console.log(`pubkey: ${ks.ownPubB64()}`)
    console.log(`\n→ import this pubkey into Alice's HEM as  ETSEIC:peer,${ks.data.handle},ik`)
    break
  }
  case 'pubkey':
    console.log(requireKeystore().ownPubB64())
    break

  case 'add-peer': {
    const [handle, pubB64] = rest
    if (!handle || !pubB64) { console.error('usage: add-peer <handle> <pubB64>'); process.exit(1) }
    const ks = requireKeystore()
    ks.addPeer(handle, pubB64)
    console.log(`peer saved: ETSEIC:peer,${handle},ik`)
    break
  }
  case 'peers': {
    const ks = requireKeystore()
    const names = Object.keys(ks.data.peers)
    console.log(names.length ? names.map(h => `  ${h}: ${ks.data.peers[h]}`).join('\n') : '(no peers)')
    break
  }
  case 'topic': {
    const [peer] = rest
    if (!peer) { console.error('usage: topic <peer> [--network m] [--date YYYY-MM-DD]'); process.exit(1) }
    const ks = requireKeystore()
    const p = { networkId: opt('--network', 'main')!, dateUTC: opt('--date', todayUTC())! }
    const ss = ks.sharedSecret(peer)
    console.log(`peer:    ${peer}`)
    console.log(`network: ${p.networkId}    date: ${p.dateUTC} (UTC)`)
    console.log(`topic:   ${await topicFromSecret(ss, p)}`)
    break
  }
  case 'join': {
    const peer = rest[0]
    if (!peer) { console.error('usage: join <peer> [--network m] [--date d] [--heartbeat ms]'); process.exit(1) }
    const ks = requireKeystore()
    const peerPub = ks.data.peers[peer]
    if (!peerPub) { console.error(`unknown peer: ${peer} — run: node bob/bob.ts add-peer ${peer} <pubB64>`); process.exit(1) }
    const pr = { networkId: opt('--network', 'main')!, dateUTC: opt('--date', todayUTC())! }
    const { multiaddr: relay } = await onchatoRelay()
    await runChatSession(softwareIdentity(KS_PATH, ks.data.handle), peerPub, ks.data.handle, peer, relay, pr)
    break
  }
  default:
    console.log('usage: bob <init|pubkey|add-peer <h> <b64>|peers|topic <peer>|join <peer> [--network m] [--date YYYY-MM-DD]>')
}
