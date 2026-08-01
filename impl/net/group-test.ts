/**
 * group-test.ts — a group over the REAL onchato relay, with SOFTWARE identities.
 *
 *   npm run group-test          # 3 members (default)
 *   N=5 npm run group-test      # 5 members
 *
 * Proves the group stack end to end with no HEM: N software peers each start a
 * session, form a group (Sender Keys), join the shared topic, and everyone reads
 * everyone's broadcasts. Distribution here is in-process (the 1:1-SKD-over-ratchet
 * path is unit-tested); this test is about the group-msg path over the live mesh.
 * Exits 0 on success.
 */

import { startSession, type Identity } from '../lib/core.ts'
import { onchatoRelay } from './onchato.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64 } from '../lib/wc.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function softId(handle: string): Promise<Identity> {
  const k = await generateX25519()
  return { handle, pub: b64(k.pub), ecdh: async (peerPubB64) => k.dh(unb64(peerPubB64)) }
}

const N = Number(process.env.N ?? 3)
const { multiaddr: RELAY } = await onchatoRelay()
const params = { networkId: 'group-test', dateUTC: new Date().toISOString().slice(0, 10) }

const ids = await Promise.all(Array.from({ length: N }, (_, i) => softId('g' + i)))
const sessions = await Promise.all(ids.map((id) => startSession(id, { relay: RELAY, params })))
console.log(`${N} software members up on ${RELAY.slice(0, 28)}…`)

// Form the group: member 0 creates it, then everyone's SKD reaches everyone.
const gk = await generateX25519()
const roster = ids.map((id) => ({ pub: id.pub }))
const gid = await sessions[0].groups.createGroup(gk.pub, roster)
for (const r of sessions.slice(1)) await r.groups.applySkd(ids[0].pub, sessions[0].groups.skdFor(gid)!)
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) await sessions[j].groups.applySkd(ids[i].pub, sessions[i].groups.skdFor(gid)!)

const got: { from: string; body: string }[][] = ids.map(() => [])
const rooms = await Promise.all(sessions.map((s, i) => s.openGroup(gid, { onMessage: (from, env) => got[i].push({ from, body: env.body }) })))
console.log(`group topic ${rooms[0].topic.slice(0, 16)}… — all ${N} joined`)

/** Broadcast from `sender` until every other member has it (mesh forms over a few s). */
async function reaches(sender: number, marker: string, ms = 45_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await rooms[sender].sendText(marker)
    await sleep(3_000)
    const others = got.filter((_, i) => i !== sender)
    const n = others.filter((r) => r.some((m) => m.body === marker)).length
    console.log(`  from g${sender}: ${n}/${N - 1} received`)
    if (n === N - 1) return true
  }
  return false
}

let ok = true
const m1 = 'hej-' + Date.now().toString(36)
if (await reaches(0, m1)) console.log(`✔ g0's broadcast reached the other ${N - 1}`)
else { ok = false; console.log('✖ g0 broadcast did not reach everyone') }
if (got[0].some((m) => m.body === m1)) { ok = false; console.log('✖ sender received its own echo') }
else console.log('✔ the sender did not receive its own broadcast')

const m2 = 'od-g' + (N - 1) + '-' + Date.now().toString(36)
if (await reaches(N - 1, m2)) console.log(`✔ g${N - 1}'s broadcast reached the other ${N - 1} (every member can send)`)
else { ok = false; console.log(`✖ g${N - 1} broadcast did not reach everyone`) }

for (const r of rooms) r.stop()
await Promise.all(sessions.map((s) => s.close()))
console.log(ok ? `\nPASS — ${N}-member group over the live relay` : '\nFAIL')
process.exit(ok ? 0 : 1)
