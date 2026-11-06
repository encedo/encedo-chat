/**
 * hem-gk-test.ts — groups bucket A+D against a REAL HEM.
 *
 * Everything in `test/group-hem-gk.test.ts` runs against a fake device. The
 * fake is real X25519 underneath and counts calls, so it proves the crypto and
 * the call bounds — but by construction it cannot answer the questions that are
 * about the actual firmware:
 *
 *   1. Does `ecdh` on an HSM-held GK agree with software X25519 the other way
 *      round? The whole roster-MAC design rests on `ECDH(GK_priv, IK_i)` (admin,
 *      in-device) equalling `ECDH(IK_i, GK_pub)` (member, client-side). If the
 *      device disagreed — encoding, clamping, anything — the admin would MAC
 *      rosters no member could verify.
 *   2. Does `updateKey` work, and is `keymgmt:upd` really its scope? That call
 *      is how a membership change rewrites the marker.
 *   3. Does a marker DESCR survive the round trip through the 128-byte field,
 *      and does `searchKeys` find it by prefix?
 *   4. What do real KIDs look like? Hint packing assumes hex; if they are not,
 *      the blob is skipped (by design) and we want to know that now.
 *
 * It creates its own throwaway key, cleans it up, and touches nothing else.
 *
 *   HEM_PASS=... node net/hem-gk-test.ts --hsm https://my.ence.do [--keep]
 *
 * The password comes from the environment, never an argument — arguments are
 * visible to every process on the box via /proc.
 *
 *   5. Firmware 1.3: does HKDF in the device (`ecdhHkdf`) give exactly what the
 *      client computes over the raw ECDH, same salt and info, byte for byte?
 *      If not, every rendezvous topic derived either way lands in a different
 *      room, and the failure presents as "the other person never shows up".
 *      Covered: several outputs from one ECDH, an empty context (no salt), a
 *      16-byte output whose first 4 bytes are the 4-byte one (the rotation
 *      offset asks the device for 16), a peer stored in the HEM (`extKid`), and
 *      DH with the key's own public key (the self-topic). The raw comparison
 *      needs the `raw_ecdh_enabled` policy; without it the equality is skipped
 *      and said so.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, sha256, kdf } from '../lib/wc.ts'
import { buildMarker, parseMarker, MARKER_PREFIX, MARKER_SEARCH, DESCR_MAX, byteLen } from '../lib/gmarker.ts'
import { groupIdFromGK } from '../lib/group.ts'

const args = process.argv.slice(2)
const hsm = args[args.indexOf('--hsm') + 1]
const keep = args.includes('--keep')
const pass = process.env.HEM_PASS
if (!hsm || args.indexOf('--hsm') < 0) { console.error('usage: HEM_PASS=... node net/hem-gk-test.ts --hsm <url> [--keep]'); process.exit(2) }
if (!pass) { console.error('set HEM_PASS in the environment (not as an argument)'); process.exit(2) }

let pass_ = 0, fail_ = 0
const ok = (cond: boolean, msg: string, detail = '') => {
  if (cond) { pass_++; console.log(`  [ok] ${msg}${detail ? ` — ${detail}` : ''}`) }
  else { fail_++; console.log(`  [fail] ${msg}${detail ? ` — ${detail}` : ''}`) }
}
const step = (s: string) => console.log(`\n${s}`)
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('')
const dec = new TextDecoder()

const hem = new HEM(hsm, { debug: args.includes('--debug') })
let gkKid = ''

try {
  step('connect')
  await hem.hemCheckin() // fast-fail + clock sync before auth
  ok(true, 'hemCheckin', hsm)

  // ---- 1. create the GK, exactly as hemGkBackend.create does ---------------
  step('create GK in the HSM (bucket A)')
  const member = await generateX25519() // stands in for a member's IK, client-side
  const marker0 = await buildMarker({
    admin: { pub: new Uint8Array(32) }, // placeholder: the real admin KID is filled in below
    members: [{ pub: member.pub }],
    name: 'gk-selftest',
  })
  const gen = await hem.authorizePassword(pass, 'keymgmt:gen')
  const created = await hem.createKeyPair(gen, 'chat-gk-selftest', 'CURVE25519', { descr: marker0.descr, returnPubkey: true })
  gkKid = created.kid
  ok(!!gkKid, 'createKeyPair CURVE25519 returned a kid', gkKid)
  ok(/^[0-9a-f]+$/i.test(gkKid), 'KID is hex (hint packing depends on this)', `${gkKid.length} chars`)

  const use = await hem.authorizePassword(pass, `keymgmt:use:${gkKid}`)
  const { pubkey: gkPub, type } = await hem.getKeyPublicInfo(use, gkKid)
  ok(gkPub.length === 32, 'GK_pub is 32 raw bytes', `type=${type}`)
  ok(!!created.pubkey && hex(created.pubkey) === hex(gkPub), 'createKeyPair returnPubkey hands back the same key (no second read)')
  console.log(`    GK_pub (base64) ${b64(gkPub)}`)
  console.log(`    GK_pub (hex)    ${hex(gkPub)}`)
  const gid = await groupIdFromGK(gkPub)
  ok(gid.length === 16, 'gid = SHA-256(GK_pub)[0:16]', hex(gid))

  // ---- 2. THE property the roster MAC rests on ----------------------------
  step('ECDH commutativity: in-device GK vs client-side member')
  // The member side is software X25519, so this is the reference for every
  // derivation below whether or not the device may hand out the raw secret.
  const ssMember = await member.dh(gkPub)
  let raw: Uint8Array | null = null
  try {
    raw = await hem.ecdh(use, gkKid, { pubkey: member.pub })
  } catch (e: any) {
    if (e?.code !== 'http_403') throw e
    console.log('    (no raw_ecdh_enabled policy: raw ECDH refused, as firmware 1.3 does by default)')
  }
  if (raw) {
    ok(raw.length === 32, 'the device returned a 32-byte raw secret')
    ok(hex(raw) === hex(ssMember),
      'ECDH(GK_priv, IK_member) in-device == ECDH(IK_member, GK_pub) client-side',
      'this is what makes an admin roster MAC verifiable by a member')
    const again = await hem.ecdh(use, gkKid, { pubkey: member.pub })
    ok(hex(again) === hex(raw), 'ecdh is deterministic across calls')
  }

  // ---- 2b. firmware 1.3: HKDF in the device == HKDF here ------------------
  step('HKDF in the device (ecdhHkdf) == HKDF over the same ECDH in the client')
  const label = 'onchato-selftest-v1'                    // 'encedo-...' is reserved by the device
  const ctx = new TextEncoder().encode('main\x002026-11-07') // the shape of a rendezvous context
  const [okmA, okmB, okm16] = await hem.ecdhHkdf(use, gkKid, {
    pubkey: member.pub,
    items: [
      { hkdfSalt: ctx, hkdfCtx: label, hkdfLen: 32 },
      { hkdfCtx: label + '-nosalt', hkdfLen: 32 },      // empty context: no salt at all
      { hkdfSalt: ctx, hkdfCtx: label, hkdfLen: 16 },
    ],
  })
  ok(hex(okmA) === hex(await kdf(label, ssMember, ctx, 32)), 'one item: device == client HKDF(ss, salt=ctx, info=label, 32)')
  ok(hex(okmB) === hex(await kdf(label + '-nosalt', ssMember, new Uint8Array(0), 32)), 'no salt: device == client HKDF with an empty salt')
  ok(hex(okm16) === hex(okmA.subarray(0, 16)), 'a shorter output is the prefix of a longer one (so 4 bytes = first 4 of 16)')
  ok(hex(okm16.subarray(0, 4)) === hex(await kdf(label, ssMember, ctx, 4)), 'the first 4 of 16 == a client 4-byte HKDF (rotation offset)')
  const single = await hem.ecdh(use, gkKid, { pubkey: member.pub, alg: 'HKDF-SHA2-256', hkdfSalt: ctx, hkdfCtx: label, hkdfLen: 32 })
  ok(hex(single) === hex(okmA), 'ecdh with alg HKDF == the same item of ecdhHkdf')

  // A peer stored in the HEM: the two-KID form of a contact.
  let impKid = ''
  try {
    const imp = await hem.authorizePassword(pass, 'keymgmt:imp')
    impKid = (await hem.importPublicKey(imp, 'chat-gk-selftest-peer', 'CURVE25519', member.pub, { descr: 'onchato-selftest' })).kid
    const [viaKid] = await hem.ecdhHkdf(use, gkKid, { extKid: impKid, items: [{ hkdfSalt: ctx, hkdfCtx: label, hkdfLen: 32 }] })
    ok(hex(viaKid) === hex(okmA), 'a stored peer (extKid) derives the same as its raw public key')
  } finally {
    if (impKid) await hem.deleteKey(await hem.authorizePassword(pass, 'keymgmt:del'), impKid).catch(() => {})
  }

  // DH with the key's own public key: the self-topic (§9.1) and the decoy seed.
  const [self] = await hem.ecdhHkdf(use, gkKid, { pubkey: gkPub, items: [{ hkdfCtx: label, hkdfLen: 32 }] })
  ok(self.length === 32, 'DH with its own public key is allowed (self-topic)')

  // The reserved prefix: what made every 'encedo-chat-...' label unusable.
  let reserved = ''
  try {
    await hem.ecdhHkdf(use, gkKid, { pubkey: member.pub, items: [{ hkdfCtx: 'encedo-chat-rendezvous-v1' }] })
    reserved = 'accepted'
  } catch (e: any) { reserved = e?.code ?? 'error' }
  ok(reserved !== 'accepted', "an info starting with 'encedo-' is refused (by the SDK, which mirrors the device's rule)", reserved)

  // ---- 3. the marker: rewrite (membership change) and find it -------------
  step('marker: updateKey (bucket D write path)')
  const real = await buildMarker({ admin: { kid: gkKid }, members: [{ pub: member.pub }], name: 'gk-selftest' })
  ok(byteLen(real.descr) <= DESCR_MAX, 'marker fits the 128-byte field', `${byteLen(real.descr)} B`)
  let updOk = true
  try {
    const upd = await hem.authorizePassword(pass, 'keymgmt:upd')
    await hem.updateKey(upd, gkKid, 'chat-gk-selftest', real.descr)
  } catch (e: any) { updOk = false; ok(false, 'updateKey with scope keymgmt:upd', e?.message ?? String(e)) }
  if (updOk) ok(true, 'updateKey with scope keymgmt:upd')

  step('marker: key_search by prefix, and the DESCR round trip')
  const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
  const found: any[] = []
  for await (const k of hem.searchKeysAll(listTok, MARKER_SEARCH)) found.push(k)
  const mine = found.find((k) => k.kid === gkKid)
  ok(!!mine, `searchKeys("${MARKER_SEARCH}") returns the group`, `${found.length} marker key(s) on this HEM`)
  if (mine) {
    // description comes back as the raw field: NUL padding is expected.
    const raw = mine.description instanceof Uint8Array ? dec.decode(mine.description) : String(mine.description ?? '')
    const clean = raw.replace(/\0+$/, '')
    ok(clean === real.descr, 'the DESCR survives the round trip byte for byte',
      clean === real.descr ? `${byteLen(clean)} B` : `got ${JSON.stringify(clean.slice(0, 60))}`)
    const parsed = parseMarker(clean)
    ok(!!parsed, 'and parses back as a marker')
    if (parsed) {
      ok(parsed.adminKid === gkKid.toLowerCase().slice(0, 8), 'admin hint round-tripped', parsed.adminKid)
      ok(parsed.hints.length === 1, 'the roster blob round-tripped', `crc=${parsed.crc.toString(16)}`)
      ok(parsed.name === 'gk-selftest', 'the name round-tripped', parsed.name)
    }
  }
} catch (e: any) {
  fail_++
  console.log(`\n[fail] aborted: ${e?.message ?? e}`)
} finally {
  if (gkKid && !keep) {
    try {
      const del = await hem.authorizePassword(pass, 'keymgmt:del')
      await hem.deleteKey(del, gkKid)
      console.log(`\n| cleaned up the test key ${gkKid}`)
    } catch (e: any) {
      console.log(`\n! could not delete the test key ${gkKid}: ${e?.message ?? e} — remove it by hand`)
    }
  } else if (gkKid) console.log(`\n| kept the test key ${gkKid} (--keep)`)
}

console.log(`\n${fail_ ? 'FAIL' : 'PASS'} — ${pass_} ok, ${fail_} failed`)
process.exit(fail_ ? 1 : 0)
