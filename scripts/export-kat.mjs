#!/usr/bin/env node
/**
 * export-kat.mjs - re-record the known-answer vectors in docs/kat/ from the
 * implementation (SPEC.md 12).
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
import { ratchetFrom } from '../impl/eh2/ratchet.ts'
import { sealKnock } from '../impl/lib/knock.ts'
import { inviteKey } from '../impl/lib/inbox.ts'
import { kdf } from '../impl/lib/wc.ts'

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

// The hybrid ratchet (7.2): a scripted exchange with fixed ratchet keys (0x50,
// 0x51, ... as the ephemeral scalars, in the order generated), the seeded
// ML-KEM, K = 1 so every step issues a key, the clock frozen.
const script = [['I', 'a'], ['R', 'b'], ['I', 'c'], ['R', 'd'], ['I', 'e'], ['R', 'f']]
async function ratchetKat() {
  const kem = mlkem768Seeded(new Uint8Array(MLKEM768_SEED).fill(0x55), fill(0x66))
  let k = 0x50
  const generateDh = async () => x25519FromPriv(fill(k++))
  const ikI = await x25519FromPriv(fill(0x11)), ikR = await x25519FromPriv(fill(0x22))
  const i1 = await initiate({ tagKey: TAG_KEY, ik: ikI, peerIkPub: ikR.pub, kem, now: NOW, ek: await x25519FromPriv(fill(0x33)) })
  const r1 = await respond({ tagKey: TAG_KEY, ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW, ek: await x25519FromPriv(fill(0x44)) })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  const opts = { kem, generateDh, pqEverySteps: 1, now: () => NOW }
  const I = await ratchetFrom(i2.result, opts), R = await ratchetFrom(rr, opts)
  const te = new TextEncoder(), td = new TextDecoder()
  const frames = []
  for (const [who, text] of script) {
    const [from, to] = who === 'I' ? [I, R] : [R, I]
    const f = await from.encrypt(te.encode(text)); frames.push(hex(f))
    if (td.decode(await to.decrypt(f)) !== text) throw new Error('ratchet KAT: frame did not open')
  }
  return { ...common, kem: hybrid.kem, ratchet_dh_privs: 'fill(0x50), fill(0x51), ... in generation order', pq_every_steps: 1, script, frames, pq_steps: I.stats().pqSteps,
    note: 'Header 0x10/0x11 per 7.2; hybrid step info "encedo-ratchet-hybrid-v1" with ikm = X25519 || ss; classical step info "encedo-ratchet-dh-v1".' }
}
const ratchet = await ratchetKat()

// The published-invite knock (5.8): the invite key derived from the identity,
// then one frame sealed to it under a fixed ephemeral.
async function knockKat() {
  const ik = await x25519FromPriv(fill(0x11))
  const inviteSecret = fill(0x22)
  const key = await inviteKey(inviteSecret, async (l, c, n) => kdf(l, await ik.dh(ik.pub), c, n))
  const eph = await x25519FromPriv(fill(0x33))
  const answerer = await x25519FromPriv(fill(0x44))
  const frame = await sealKnock(inviteSecret, key.pub, { ik: answerer.pub, name: 'Ala', note: 'Dzień dobry' }, { eph })
  return {
    ik_priv: hex(fill(0x11)), invite_secret: hex(inviteSecret), invite_pub: hex(key.pub),
    eph_priv: hex(fill(0x33)), answerer_ik_pub: hex(answerer.pub), name: 'Ala', note: 'Dzień dobry',
    frame: hex(frame),
    note_construction: 'invite_priv = HKDF(ECDH(IK, IK_pub), salt=invite_secret, info="encedo-chat-invite-key-v1", 32), clamped by X25519; '
      + 'k || nonce = HKDF(ECDH(eph, invite_pub), salt=invite_secret, info="encedo-chat-invite-knock-v2", 44); '
      + 'frame = eph_pub || AES-256-GCM(k, nonce, kind 0x01 || ik || nameLen || name(64) || noteLen u16be || note(200), no aad) (5.8).',
  }
}
const knock = await knockKat()

for (const [name, v] of [['eh2-handshake-classical', classical], ['eh2-handshake-mlkem', hybrid], ['group-senderkey', senderkey], ['ratchet-hybrid', ratchet], ['invite-knock', knock]]) {
  writeFileSync(join(out, name + '.json'), JSON.stringify(v, null, 2) + '\n')
  console.log('wrote docs/kat/' + name + '.json')
}
