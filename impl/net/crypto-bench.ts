/**
 * crypto-bench.ts — the engine-cost numbers `performance.md` cites, made
 * reproducible. The originals (2026-07-31: 20 handshakes ~ 66 ms, 1000 sealed
 * round trips ~ 417 ms) were measured with an ad-hoc script that never got
 * checked in — so the table was uncheckable and CLAUDE.md quoted numbers nobody
 * could re-derive. This is that script, versioned.
 *
 * In-process and offline on purpose: it measures the CRYPTO — EH-2 (three
 * X25519 DHs + ML-KEM-768 + transcript MACs, both sides) and the Double
 * Ratchet's seal/open — with no relay, no GossipSub, no browser. Network
 * latency is a different benchmark (`relay-load` has it).
 *
 *   node net/crypto-bench.ts [handshakes] [roundtrips]     (defaults 20 / 1000)
 *
 * Software identities (WebCrypto X25519), like the browser uses for local
 * ephemerals; a HEM identity adds one device round-trip per side per handshake
 * on top of these numbers, and nothing per message (`hem_usage.md`).
 */

import { startHandshake } from '../eh2/establish.ts'
import { generateX25519 } from '../lib/x25519.ts'
import type { Session } from '../lib/session.ts'

const HANDSHAKES = Math.max(1, parseInt(process.argv[2] ?? '20', 10) || 20)
const ROUNDTRIPS = Math.max(1, parseInt(process.argv[3] ?? '1000', 10) || 1000)

async function connect(): Promise<{ i: Session; r: Session }> {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const I = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub })
  const R = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })
  const msg2 = await R.feed(I.initial[0])
  const msg3 = await I.feed(msg2!)
  await R.feed(msg3!)
  return { i: await I.session, r: await R.session }
}

const ms = (n: bigint) => Number(n) / 1e6

async function main() {
  // Warm-up: JIT + WebCrypto key-import paths, so the measured loop is steady state.
  await connect()

  let t0 = process.hrtime.bigint()
  let last: { i: Session; r: Session } = null as any
  for (let n = 0; n < HANDSHAKES; n++) last = await connect()
  const hsMs = ms(process.hrtime.bigint() - t0)

  const payload = new TextEncoder().encode('a sealed round trip of ordinary length, more or less')
  t0 = process.hrtime.bigint()
  for (let n = 0; n < ROUNDTRIPS; n++) {
    const pt = await last.r.decrypt(await last.i.encrypt(payload))
    if (pt === null) throw new Error(`round trip ${n} failed to open`)
  }
  const rtMs = ms(process.hrtime.bigint() - t0)

  console.log(`crypto-bench — ${process.arch}, node ${process.version}`)
  console.log(`  ${HANDSHAKES} full EH-2 handshakes, both sides: ${hsMs.toFixed(0)} ms  -> ${(hsMs / HANDSHAKES).toFixed(2)} ms each`)
  console.log(`  ${ROUNDTRIPS} sealed round trips (one ratchet): ${rtMs.toFixed(0)} ms  -> ${(rtMs / ROUNDTRIPS).toFixed(3)} ms/msg`)
}

main().catch((e) => { console.error(e); process.exit(1) })
