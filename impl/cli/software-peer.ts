/**
 * software-peer.ts — shared CLI for a software-identity peer (Bob, Carl, …).
 * Thin per-profile entrypoints (bob/bob.ts, carl/carl.ts) call this with their
 * own keystore path + name. Key stays in a local file; ECDH via node X25519.
 *
 *   init [--handle <h>]                            generate identity, print pubkey
 *   pubkey                                          print pubkey (base64) to hand out
 *   add-peer <handle> <pubB64>                      save a peer's pubkey
 *   peers                                           list stored peers
 *   topic <peer> [--network m] [--date YYYY-MM-DD]  derive the rendezvous topic
 *   join <peer> [--network m] [--date d]            open a live chat
 *
 * Flow: `init` → give the printed pubkey to the peer (imports it into their HEM
 * as a contact) → `add-peer <them> <their_pub>` → `join <them>`.
 */

import { Keystore } from '../bob/keystore.ts'
import { topicFromSecret, todayUTC } from '../lib/rendezvous.ts'
import { softwareIdentity } from './identity.ts'
import { runChatSession } from './chat-session.ts'
import { onchatoRelay } from '../net/onchato.ts'

export async function softwarePeerCli(ksPath: string, name: string) {
  const Name = name.charAt(0).toUpperCase() + name.slice(1)
  const [cmd, ...rest] = process.argv.slice(2)
  const opt = (n: string, def?: string): string | undefined => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : def }
  const requireKeystore = (): Keystore => {
    if (!Keystore.exists(ksPath)) { console.error(`No keystore — run: node ${name}/${name}.ts init`); process.exit(1) }
    return Keystore.load(ksPath)
  }

  switch (cmd) {
    case 'init': {
      if (Keystore.exists(ksPath)) { console.error('Keystore already exists:', ksPath); process.exit(1) }
      const ks = Keystore.create(ksPath, opt('--handle', name)!)
      console.log(`${Name} created — handle "${ks.data.handle}"`)
      console.log(`DESCR:  ${ks.descrSelf()}`)
      console.log(`pubkey: ${ks.ownPubB64()}`)
      // Not a DESCR to copy: a contact record now names the OWNING identity's
      // KID, which this keystore does not know. The app builds it on import.
      console.log(`\n→ add this pubkey as a contact on the peer's side, under the name "${ks.data.handle}"`)
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
      console.log(`peer saved: ${handle}`)
      break
    }
    case 'peers': {
      const ks = requireKeystore()
      const names = Object.keys(ks.data.peers)
      console.log(names.length ? names.map((h) => `  ${h}: ${ks.data.peers[h]}`).join('\n') : '(no peers)')
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
      if (!peer) { console.error('usage: join <peer> [--network m] [--date d]'); process.exit(1) }
      const ks = requireKeystore()
      const peerPub = ks.data.peers[peer]
      if (!peerPub) { console.error(`unknown peer: ${peer} — run: node ${name}/${name}.ts add-peer ${peer} <pubB64>`); process.exit(1) }
      const pr = { networkId: opt('--network', 'main')!, dateUTC: opt('--date', todayUTC())! }
      const { multiaddr: relay } = await onchatoRelay()
      await runChatSession(softwareIdentity(ksPath, ks.data.handle), peerPub, ks.data.handle, peer, relay, pr)
      break
    }
    default:
      console.log(`usage: ${name} <init [--handle h]|pubkey|add-peer <h> <b64>|peers|topic <peer>|join <peer> [--network m] [--date YYYY-MM-DD]>`)
  }
}
