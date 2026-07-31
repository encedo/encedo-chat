/**
 * gui-sim.ts — drive the GUI's code path without a GUI.
 *
 * Two "browser tabs" = two `openConversation()` calls with exactly the options
 * `web/src/app.ts` passes, against the real onchato relay. It exercises the
 * facade the buttons are wired to (open room → EH-2 → sendText both ways →
 * leave) and prints a timeline, so a slow or half-open handshake shows up as
 * numbers instead of "nic się nie dzieje".
 *
 *   node net/gui-sim.ts            # EH-2 (what ?eh2=1 does)
 *
 * Difference from a real browser: no WebRTC (Node has no RTCPeerConnection), so
 * content stays on GossipSub — the relay-fallback path.
 */

import { generateX25519 } from '../lib/x25519.ts'
import { openConversation, type Identity } from '../lib/core.ts'
import { b64 } from '../lib/wc.ts'
import { onchatoRelay } from './onchato.ts'

const t0 = Date.now()
const log = (who: string, what: string) => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${who}: ${what}`)

/** The same contract `browserSoftwareIdentity` gives the GUI, minus storage. */
async function softIdentity(handle: string): Promise<Identity> {
  const k = await generateX25519()
  return { handle, pub: b64(k.pub), ecdh: async (peerPubB64) => k.dh(Uint8Array.from(atob(peerPubB64), (c) => c.charCodeAt(0))) }
}

const { multiaddr: RELAY } = await onchatoRelay()
const dev1 = await softIdentity('dev1')
const dev2 = await softIdentity('dev2')
const params = { networkId: 'main', dateUTC: '2026-01-02' } // fixed test room

const inbox = { dev1: [] as string[], dev2: [] as string[] }
const open = (me: Identity, peerPub: string, name: 'dev1' | 'dev2') =>
  openConversation(me, { pub: peerPub }, {
    relay: RELAY,
    params,
    webrtc: false, // browser-only; in Node content stays on GossipSub
    onSecurity: (peer, state) => log(name, `EH-2 ${state} with ${peer.slice(0, 12)}…`),
    onMessage: (_from, m) => { inbox[name].push(m.body); log(name, `received "${m.body}"`) },
    onPresence: (peer, ev) => log(name, `presence ${ev} (${peer.slice(0, 12)}…)`),
  })

log('sim', `mode=EH-2  relay=${RELAY.slice(0, 40)}…`)
const c1 = await open(dev1, dev2.pub, 'dev1')
log('dev1', `room open, topic=${c1.topic.slice(0, 12)}… as ${c1.peerId.slice(0, 12)}…`)
const c2 = await open(dev2, dev1.pub, 'dev2')
log('dev2', `room open as ${c2.peerId.slice(0, 12)}…`)

const until = async (cond: () => boolean, ms: number) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await new Promise((r) => setTimeout(r, 100))
  }
  return true
}

// What a user does: type into the box. Retried, because until the mesh forms
// nothing at all crosses the relay.
let sent1 = 0, sent2 = 0
const typing = setInterval(() => {
  c1.sendText(`z dev1 #${++sent1}`)
  c2.sendText(`z dev2 #${++sent2}`)
}, 3000)

const ok = await until(() => inbox.dev1.length > 0 && inbox.dev2.length > 0, 90_000)
clearInterval(typing)
if (ok) log('sim', `first messages delivered BOTH ways (dev1 got ${inbox.dev1.length}, dev2 got ${inbox.dev2.length})`)

// And a round trip after the fact, to prove the ratchet keeps stepping.
const before = { d1: inbox.dev1.length, d2: inbox.dev2.length }
c1.sendText('po ustanowieniu — dev1')
c2.sendText('po ustanowieniu — dev2')
const ok2 = await until(() => inbox.dev1.length > before.d1 && inbox.dev2.length > before.d2, 20_000)

await Promise.allSettled([c1.leave(), c2.leave()])
if (ok && ok2) { console.log('\nPASS — GUI path works end to end (EH-2)'); process.exit(0) }
console.log(`\nFAIL — first-exchange=${ok} follow-up=${ok2}; dev1 inbox=${inbox.dev1.length} dev2 inbox=${inbox.dev2.length}`)
process.exit(1)
