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
 *   HEM_PASS=… node net/hem-gk-test.ts --hsm https://my.ence.do [--keep]
 *
 * The password comes from the environment, never an argument — arguments are
 * visible to every process on the box via /proc.
 *
 * ── TODO, firmware ≥ 2026-08-10: cover `ecdhDerive` (HKDF in the device) ──
 *
 * The new firmware adds
 *   `ecdhDerive(token, kid, peerPub, salt, info, len)
 *      = HKDF-SHA256(ikm = X25519(priv[kid], peerPub), salt, info, len)`
 * under the SAME `keymgmt:use:<kid>` scope (salt ≤64 B, info ≤128 B, len ≤64 B).
 * It is what closes the gap this whole spike works around: today the pair secret
 * `ss` transits client RAM because the HKDF happens here, not in the device.
 *
 * The check that matters is one equality — in-device against client-side over
 * the raw ECDH, same salt and info, byte for byte. If those differ, every
 * rendezvous topic derived either way lands in a different room, and the failure
 * presents as "the other person never shows up".
 *
 * Then the `wm` scheme (see the window-key note): the device derives
 * `wm = HKDF(ss, "encedo-chat-window-v1", paramsInfo(date, offset), 32)` and the
 * host derives topic and MAC key from `wm` — so a host compromise yields one
 * window, not every window this pair will ever use.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, sha256 } from '../lib/wc.ts'
import { buildMarker, parseMarker, MARKER_PREFIX, MARKER_SEARCH, DESCR_MAX, byteLen } from '../lib/gmarker.ts'
import { groupIdFromGK } from '../lib/group.ts'

const args = process.argv.slice(2)
const hsm = args[args.indexOf('--hsm') + 1]
const keep = args.includes('--keep')
const pass = process.env.HEM_PASS
if (!hsm || args.indexOf('--hsm') < 0) { console.error('usage: HEM_PASS=… node net/hem-gk-test.ts --hsm <url> [--keep]'); process.exit(2) }
if (!pass) { console.error('set HEM_PASS in the environment (not as an argument)'); process.exit(2) }

let pass_ = 0, fail_ = 0
const ok = (cond: boolean, msg: string, detail = '') => {
  if (cond) { pass_++; console.log(`  ✔ ${msg}${detail ? ` — ${detail}` : ''}`) }
  else { fail_++; console.log(`  ✖ ${msg}${detail ? ` — ${detail}` : ''}`) }
}
const step = (s: string) => console.log(`\n▸ ${s}`)
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
  const asB64 = (s: string) => b64(new TextEncoder().encode(s))
  const created = await hem.createKeyPair(gen, 'chat-gk-selftest', 'CURVE25519', asB64(marker0.descr))
  gkKid = created.kid
  ok(!!gkKid, 'createKeyPair CURVE25519 returned a kid', gkKid)
  ok(/^[0-9a-f]+$/i.test(gkKid), 'KID is hex (hint packing depends on this)', `${gkKid.length} chars`)

  const use = await hem.authorizePassword(pass, `keymgmt:use:${gkKid}`)
  const { pubkey, type } = await hem.getPubKey(use, gkKid)
  const gkPub = unb64(pubkey)
  ok(gkPub.length === 32, 'GK_pub is 32 raw bytes', `type=${type}`)
  console.log(`    GK_pub (base64) ${pubkey}`)
  console.log(`    GK_pub (hex)    ${hex(gkPub)}`)
  const gid = await groupIdFromGK(gkPub)
  ok(gid.length === 16, 'gid = SHA-256(GK_pub)[0:16]', hex(gid))

  // ---- 2. THE property the roster MAC rests on ----------------------------
  step('ECDH commutativity: in-device GK vs client-side member')
  const ssAdmin = new Uint8Array(await hem.ecdh(use, gkKid, b64(member.pub)))
  const ssMember = await member.dh(gkPub)
  ok(ssAdmin.length === 32, 'the device returned a 32-byte raw secret')
  ok(hex(ssAdmin) === hex(ssMember),
    'ECDH(GK_priv, IK_member) in-device == ECDH(IK_member, GK_pub) client-side',
    'this is what makes an admin roster MAC verifiable by a member')

  // A second call must be identical — the memo caches this value for the life
  // of the group, so a device that varied here would break every later epoch.
  const again = new Uint8Array(await hem.ecdh(use, gkKid, b64(member.pub)))
  ok(hex(again) === hex(ssAdmin), 'ecdh is deterministic across calls (the memo relies on it)')

  // ---- 3. the marker: rewrite (membership change) and find it -------------
  step('marker: updateKey (bucket D write path)')
  const real = await buildMarker({ admin: { kid: gkKid }, members: [{ pub: member.pub }], name: 'gk-selftest' })
  ok(byteLen(real.descr) <= DESCR_MAX, 'marker fits the 128-byte field', `${byteLen(real.descr)} B`)
  let updOk = true
  try {
    const upd = await hem.authorizePassword(pass, 'keymgmt:upd')
    await hem.updateKey(upd, gkKid, 'chat-gk-selftest', asB64(real.descr))
  } catch (e: any) { updOk = false; ok(false, 'updateKey with scope keymgmt:upd', e?.message ?? String(e)) }
  if (updOk) ok(true, 'updateKey with scope keymgmt:upd')

  step('marker: key_search by prefix, and the DESCR round trip')
  const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
  const found: any[] = await hem.searchKeys(listTok, MARKER_SEARCH)
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
  console.log(`\n✖ aborted: ${e?.message ?? e}`)
} finally {
  if (gkKid && !keep) {
    try {
      const del = await hem.authorizePassword(pass, 'keymgmt:del')
      await hem.deleteKey(del, gkKid)
      console.log(`\n· cleaned up the test key ${gkKid}`)
    } catch (e: any) {
      console.log(`\n! could not delete the test key ${gkKid}: ${e?.message ?? e} — remove it by hand`)
    }
  } else if (gkKid) console.log(`\n· kept the test key ${gkKid} (--keep)`)
}

console.log(`\n${fail_ ? 'FAIL' : 'PASS'} — ${pass_} ok, ${fail_} failed`)
process.exit(fail_ ? 1 : 0)
