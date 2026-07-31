/**
 * presence-test.ts — the two-layer model end to end over the real relay.
 *
 *   node net/presence-test.ts
 *
 * Proves the thing the design is for: two peers see each other ONLINE with only
 * the light presence layer — no handshake, no room — and then a conversation
 * upgrades from it when one side sends. Exits 0 on success.
 */

import { startSession, type Identity } from '../lib/core.ts'
import { onchatoRelay } from './onchato.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

async function softId(handle: string): Promise<Identity> {
  const k = await generateX25519()
  return { handle, pub: b64(k.pub), ecdh: async (peerPubB64) => k.dh(Uint8Array.from(atob(peerPubB64), (c) => c.charCodeAt(0))) }
}

const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)) }
}

const { multiaddr: RELAY } = await onchatoRelay()
const params = { networkId: 'presence-test', dateUTC: new Date().toISOString().slice(0, 10) }
const A = await softId('alice'); const B = await softId('bob')

const sA = await startSession(A, { relay: RELAY, params })
const sB = await startSession(B, { relay: RELAY, params })

let aSeesB = false, bSeesA = false, bWants = false
const gotByB: string[] = []

// Both start ONLY the light presence layer — no conversation opened.
await sA.watchContacts([{ pub: B.pub }], { onOnline: () => { aSeesB = true } })
await sB.watchContacts([{ pub: A.pub }], {
  onOnline: () => { bSeesA = true },
  onWantsConversation: async () => { // A started talking → upgrade B to a full room
    bWants = true
    const conv = await sB.open({ pub: A.pub }, { params, onMessage: (_f, m) => gotByB.push(m.body) })
    void conv
  },
})

const t0 = Date.now()
await until(() => aSeesB && bSeesA, 40_000, 'both see each other ONLINE via presence only')
console.log(`✔ both online via presence layer in ${Date.now() - t0} ms — no handshake, no room`)

// A upgrades: opens the conversation and sends. B should be pulled up by the
// incoming EH-2 frame and receive the message.
const convA = await sA.open({ pub: B.pub }, { params, onSecurity: () => {} })
await new Promise((r) => setTimeout(r, 500))
convA.sendText('cześć z presencji')
await until(() => bWants, 30_000, 'B was pulled into a conversation by A\'s handshake')
console.log('✔ B auto-upgraded to a conversation from the incoming EH-2 frame')
await until(() => gotByB.includes('cześć z presencji'), 40_000, 'the message arrived after the upgrade')
console.log(`✔ message delivered end to end: "${gotByB[0]}"`)

await sA.close(); await sB.close()
console.log('\nPASS — presence-only visibility, then upgrade-on-send')
process.exit(0)
