#!/usr/bin/env node
/**
 * export-kat.mjs - re-record the known-answer vectors in docs/kat/ from the
 * implementation (PROTOCOL.md 17.5).
 *
 * The tests READ these files; this script is the only thing that writes them.
 * Re-recording is a deliberate act - a vector that changes means the wire
 * format, a DH ordering, a label or a transcript changed - so run it by hand,
 * read the diff, and say in the commit why the numbers moved.
 *
 *   node scripts/export-kat.mjs
 *
 * Inputs are fixed bytes (fills and seeds) so that a port in another language
 * can reproduce them without this repository's test helpers; the toy KEM of
 * the classical vector is described in impl/test/toy-kem.ts.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initiate, initiatorComplete, respond, responderComplete } from '../impl/eh2/handshake.ts'
import { x25519FromPriv } from '../impl/lib/x25519.ts'
import { mlkem768Seeded, MLKEM768_SEED } from '../impl/eh2/mlkem.ts'
import { toyKem, seededRand } from '../impl/test/toy-kem.ts'
import { sendChainFrom, seal } from '../impl/lib/senderkey.ts'
import { b64 } from '../impl/lib/wc.ts'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'kat')
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
const fill = (v) => new Uint8Array(32).fill(v)

const TAG_KEY = fill(0x7a)
const NOW = 1_784_000_000_000

async function handshake(kem) {
  const ikI = await x25519FromPriv(fill(0x11)), ikR = await x25519FromPriv(fill(0x22))
  const ekI = await x25519FromPriv(fill(0x33)), ekR = await x25519FromPriv(fill(0x44))
  const i1 = await initiate({ tagKey: TAG_KEY, ik: ikI, peerIkPub: ikR.pub, kem, now: NOW, ek: ekI })
  const r1 = await respond({ tagKey: TAG_KEY, ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW, ek: ekR })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  if (b64(rr.sk) !== b64(i2.result.sk)) throw new Error('SK_i != SK_r')
  return { msg1: hex(i1.msg1), msg2: hex(r1.msg2), msg3: hex(i2.msg3), sk_b64: b64(i2.result.sk) }
}

const common = {
  ik_i_priv: hex(fill(0x11)), ik_r_priv: hex(fill(0x22)), ek_i_priv: hex(fill(0x33)), ek_r_priv: hex(fill(0x44)),
  tag_key: hex(TAG_KEY), now_ms: NOW,
  note: 'X25519 private scalars as given (clamped by X25519); initiator_tag = HMAC(k_tag, IK_i_pub) with k_tag = HMAC(tag_key, "encedo-eh2-initiator-tag-v1") (6.1); SK per 6.2.',
}

const classical = { ...common, kem: 'toy (impl/test/toy-kem.ts) with the seeded RNG - a stand-in that pins the schedule, not a KEM', ...(await handshake(toyKem(seededRand()))) }
const hybrid = { ...common, kem: 'ML-KEM-768, keygen seed = 0x55 x 64, encapsulation randomness = 0x66 x 32', ...(await handshake(mlkem768Seeded(new Uint8Array(MLKEM768_SEED).fill(0x55), fill(0x66)))) }

const H = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])
const key0 = fill(0x11)
const { n, ct } = await seal(sendChainFrom(key0), H, new TextEncoder().encode('hello'))
const senderkey = {
  chain_key: hex(key0), header_aad: hex(H), plaintext: 'hello', ctr: n, ct: hex(ct),
  note: 'MK = HKDF(chain, salt=empty, info="encedo-group-msg", 32); nonce = HKDF(MK, salt=empty, info="encedo-aead-nonce", 12); AES-256-GCM(MK, nonce, plaintext, aad=header) (8.1, 8.2).',
}

for (const [name, v] of [['eh2-handshake-classical', classical], ['eh2-handshake-mlkem', hybrid], ['group-senderkey', senderkey]]) {
  writeFileSync(join(out, name + '.json'), JSON.stringify(v, null, 2) + '\n')
  console.log('wrote docs/kat/' + name + '.json')
}
