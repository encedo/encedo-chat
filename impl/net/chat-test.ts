/**
 * chat-test.ts — live integration: two software peers exchange an ENCRYPTED
 * message in the deterministic room via the onchato relay. Exits 0 on success.
 *   node net/chat-test.ts
 */

import { diffieHellman, createPublicKey, randomBytes } from 'node:crypto'
import { multiaddr } from '@multiformats/multiaddr'
import { rawToPriv } from '../bob/keystore.ts'
import { topicFromSecret, announceMacKey } from '../lib/rendezvous.ts'
import { msgKeyFromSecret } from '../lib/msgcrypto.ts'
import { joinChat } from '../lib/room.ts'
import { createPeer } from './peer.ts'
import { onchatoRelay } from './onchato.ts'

const aPriv = rawToPriv(Buffer.alloc(32, 0xc1))
const bPriv = rawToPriv(Buffer.alloc(32, 0xd2))
const ss = new Uint8Array(diffieHellman({ privateKey: aPriv, publicKey: createPublicKey(bPriv) }))
const p = { networkId: 'test', dateUTC: '2026-01-01' }
const topic = await topicFromSecret(ss, p)
const keys = { macKey: await announceMacKey(ss, p), msgKey: await msgKeyFromSecret(ss, p) }
const SECRET = 'ping-' + randomBytes(4).toString('hex')

const { multiaddr: relay } = await onchatoRelay()
const na = await createPeer()
const nb = await createPeer()
await Promise.all([na.dial(multiaddr(relay)), nb.dial(multiaddr(relay))])
console.log(`dialed onchato relay; topic=${topic.slice(0, 14)}…  sending "${SECRET}"`)

let ra, rb
const received = new Promise<string>((resolve) => {
  rb = joinChat(nb, topic, keys, { onMessage: (_from, m) => resolve(m.body) })
  ra = joinChat(na, topic, keys, {})
})
const sender = setInterval(() => ra.sendText(SECRET), 3000)   // resend until the mesh forms
const got = await Promise.race([received, new Promise<null>((r) => setTimeout(() => r(null), 45_000))])

clearInterval(sender)
ra.stop(); rb.stop()
await Promise.allSettled([na.stop(), nb.stop()])

if (got === SECRET) { console.log(`PASS — B received & decrypted A's message: "${got}"`); process.exit(0) }
console.log(`FAIL — got ${JSON.stringify(got)}, expected ${SECRET}`); process.exit(1)
