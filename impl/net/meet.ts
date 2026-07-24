/**
 * meet.ts — live integration check: two software peers discover each other in the
 * deterministic room via the onchato relay. Exits 0 on success, 1 on failure.
 *
 *   node net/meet.ts
 *
 * Uses fixed test keys + a fixed date so repeated runs reuse ONE topic on the
 * production relay (v5 relay has no TTL eviction yet). 'test' network id.
 */

import { diffieHellman, createPublicKey } from 'node:crypto'
import { multiaddr } from '@multiformats/multiaddr'
import { rawToPriv } from '../bob/keystore.ts'
import { topicFromSecret, announceMacKey } from '../lib/rendezvous.ts'
import { joinRoom } from '../lib/rendezvous-net.ts'
import { createPeer } from './peer.ts'
import { onchatoRelay } from './onchato.ts'

const aPriv = rawToPriv(Buffer.alloc(32, 0xa1))
const bPriv = rawToPriv(Buffer.alloc(32, 0xb2))
const ss = new Uint8Array(diffieHellman({ privateKey: aPriv, publicKey: createPublicKey(bPriv) }))
const p = { networkId: 'test', dateUTC: '2026-01-01' }
const topic = await topicFromSecret(ss, p)
const macKey = await announceMacKey(ss, p)

const { multiaddr: relay } = await onchatoRelay()
const na = await createPeer()
const nb = await createPeer()
await Promise.all([na.dial(multiaddr(relay)), nb.dial(multiaddr(relay))])
console.log(`dialed onchato relay; topic=${topic.slice(0, 16)}…`)

let aSaw = null, bSaw = null
const met = new Promise((resolve) => {
  const check = () => { if (aSaw && bSaw) resolve(true) }
  joinRoom(na, topic, macKey, { heartbeatMs: 3000, initialDelayMs: 2000, onPeer: (pid) => { console.log(`A sees ${pid.slice(0, 12)}`); aSaw = pid; check() } })
  joinRoom(nb, topic, macKey, { heartbeatMs: 3000, initialDelayMs: 2000, onPeer: (pid) => { console.log(`B sees ${pid.slice(0, 12)}`); bSaw = pid; check() } })
})
const ok = await Promise.race([met, new Promise((r) => setTimeout(() => r(false), 40_000))])

await Promise.allSettled([na.stop(), nb.stop()])
if (ok && aSaw === nb.peerId.toString() && bSaw === na.peerId.toString()) {
  console.log('PASS — both peers met in the deterministic room via the onchato relay')
  process.exit(0)
}
console.log(`FAIL — aSaw=${aSaw} bSaw=${bSaw}`)
process.exit(1)
