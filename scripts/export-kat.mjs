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
import { kdf, aeadNonce, sha256, subtle } from '../impl/lib/wc.ts'
import { tag } from '../impl/lib/senderkey.ts'
const hmacSha256 = async (k, m) => new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), m))

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
// The group sender chain (8.1, 8.2). The top-level fields are the first case,
// kept for readers of the original vector. `cases` walk one chain to several
// counters: the 1-shaped vector alone was recorded at ctr = 0, where an empty
// HKDF salt and u32be(0) give the same HMAC key - it could not tell whether the
// counter reaches the nonce at all. Every case records mk and nonce as well,
// so a port can see which step it got wrong.
const te = new TextEncoder()
const GHDR = (() => {   // a real 8.2 header: gid(16) || sender_id(8) || epoch || ctr
  const h = new Uint8Array(32); h.fill(0xa1, 0, 16); h.fill(0xb2, 16, 24)
  const v = new DataView(h.buffer); v.setUint32(24, 5, false); return h
})()
const withCtr = (h, c) => { const x = h.slice(); if (x.length === 32) new DataView(x.buffer).setUint32(28, c, false); return x }
const MKIJ = fill(0x99)
async function chainCases(key, header, plan) {
  const chain = sendChainFrom(key)
  const out = []
  for (let c = 0; c <= Math.max(...plan.map((p) => p.ctr)); c++) {
    const want = plan.find((p) => p.ctr === c)
    const ck = chain.key.slice()
    const hdr = withCtr(header, c)
    const pt = te.encode(want ? want.plaintext : 'skipped ' + c)
    const { n, ct } = await seal(chain, hdr, pt)
    if (!want) continue
    const mk = await kdf('encedo-group-msg', ck)
    out.push({
      ctr: n, chain_key_at_ctr: hex(ck), header_aad: hex(hdr), plaintext: want.plaintext,
      mk: hex(mk), nonce: hex(await aeadNonce(mk, n)), ct: hex(ct),
      mac_under_mk_ij: hex(await tag(MKIJ, hdr, ct)),
    })
  }
  return out
}
const senderkey = {
  chain_key: hex(key0), header_aad: hex(H), plaintext: 'hello', ctr: n, ct: hex(ct),
  mk_ij: hex(MKIJ),
  cases: [
    ...(await chainCases(key0, H, [{ ctr: 0, plaintext: 'hello' }, { ctr: 1, plaintext: 'world' }, { ctr: 2, plaintext: '' }])),
    ...(await chainCases(fill(0x5a), GHDR, [
      { ctr: 0, plaintext: 'pierwsza' },
      { ctr: 3, plaintext: 'zażółć gęślą jaźń - a body past one AES block, with UTF-8 in it' },
      { ctr: 7, plaintext: 'siódma' },
    ])),
  ],
  note: 'chain_key\' = HKDF(chain, salt=empty, info="encedo-group-chain", 32); MK = HKDF(chain, salt=empty, info="encedo-group-msg", 32); '
    + 'nonce = HKDF(MK, salt=u32be(ctr), info="encedo-aead-nonce", 12); ct = AES-256-GCM(MK, nonce, plaintext, aad=header); '
    + 'mac = HMAC-SHA256(mk_ij, header || ct) (8.1, 8.2). Counters not listed in a case were sealed with "skipped <n>" to advance the chain. '
    + 'The 32-byte header is gid 0xa1 x16 || sender_id 0xb2 x8 || u32be(epoch 5) || u32be(ctr).',
}

// The 8.1 derivations and the 8.3 roster MAC, from fixed scalars. The group
// engine derives these over the identity backend; here the ECDHs are local.
async function groupKeys() {
  const gk = await x25519FromPriv(fill(0x21))
  const ia = await x25519FromPriv(fill(0x31)), ib = await x25519FromPriv(fill(0x32)), ic = await x25519FromPriv(fill(0x33))
  const gid = (await sha256(gk.pub)).slice(0, 16)
  const sid = async (p) => hex((await sha256(p)).slice(0, 8))
  const ctx = (epoch) => { const c = new Uint8Array(20); c.set(gid); new DataView(c.buffer).setUint32(16, epoch, false); return c }
  const out = { gk_priv: hex(fill(0x21)), ik_priv: { a: hex(fill(0x31)), b: hex(fill(0x32)), c: hex(fill(0x33)) },
    gk_pub: hex(gk.pub), group_id: hex(gid), sender_id: { a: await sid(ia.pub), b: await sid(ib.pub), c: await sid(ic.pub) }, epochs: [] }
  const roster = [ia.pub, ib.pub, ic.pub].map((p) => b64(p))
  for (const epoch of [0, 1, 7]) {
    const mk_ab = await kdf('encedo-group-msg-mac', await ia.dh(ib.pub), ctx(epoch))
    const mk_ba = await kdf('encedo-group-msg-mac', await ib.dh(ia.pub), ctx(epoch))
    if (hex(mk_ab) !== hex(mk_ba)) throw new Error('mk_ij not symmetric')
    const mk_ac = await kdf('encedo-group-msg-mac', await ia.dh(ic.pub), ctx(epoch))
    const rk_b = await kdf('encedo-chat-group-roster-mac', await gk.dh(ib.pub), ctx(epoch))
    const rk_b2 = await kdf('encedo-chat-group-roster-mac', await ib.dh(gk.pub), ctx(epoch))
    if (hex(rk_b) !== hex(rk_b2)) throw new Error('rk_i not symmetric')
    const rmac_b = await hmacSha256(rk_b, te.encode(roster.join('\n')))
    out.epochs.push({ epoch, mk_ab: hex(mk_ab), mk_ac: hex(mk_ac), rk_b: hex(rk_b), roster, rmac_b: hex(rmac_b) })
  }
  out.note = 'group_id = SHA-256(GK_pub)[0:16]; sender_id = SHA-256(IK_pub)[0:8]; mk_ij = HKDF(ECDH(IK_i, IK_j), salt = group_id || u32be(epoch), info="encedo-group-msg-mac", 32); '
    + 'rk_i = HKDF(ECDH(GK, IK_i), same salt, info="encedo-chat-group-roster-mac", 32); rmac = HMAC-SHA256(rk_i, UTF-8(roster.join("\\n"))) over the base64 IK_pubs in the order given, roster[0] the admin (8.1, 8.3). '
    + 'X25519 private scalars as given (clamped by X25519).'
  return out
}
const groupkeys = await groupKeys()

// The hybrid ratchet (7.2): a scripted exchange with fixed ratchet keys (0x50,
// 0x51, ... as the ephemeral scalars, in the order generated), the seeded
// ML-KEM, K = 1 so every step issues a key, the clock frozen.
// The tail sends in bursts: an alternating exchange puts every frame at n = 0
// of a fresh chain, where the counter's place in the nonce cannot be seen. The
// bursts reach n = 1 and n = 2 (I: g h i, then R: j k).
const script = [['I', 'a'], ['R', 'b'], ['I', 'c'], ['R', 'd'], ['I', 'e'], ['R', 'f'],
  ['I', 'g'], ['I', 'h'], ['I', 'i'], ['R', 'j'], ['R', 'k']]
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

for (const [name, v] of [['eh2-handshake-classical', classical], ['eh2-handshake-mlkem', hybrid], ['group-senderkey', senderkey], ['ratchet-hybrid', ratchet], ['invite-knock', knock], ['group-keys', groupkeys]]) {
  writeFileSync(join(out, name + '.json'), JSON.stringify(v, null, 2) + '\n')
  console.log('wrote docs/kat/' + name + '.json')
}
