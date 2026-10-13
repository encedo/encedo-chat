/**
 * group-keys-kat.test.ts - the SPEC.md 8.1 derivations and the 8.3 roster MAC
 * against docs/kat/group-keys.json (written only by scripts/export-kat.mjs).
 *
 * The group engine derives these through the identity backend; the vector
 * fixes the scalars, so the derivation functions of lib/group.ts are driven
 * with local ECDHs and must land on the recorded bytes. The roster MAC is
 * recomputed from WebCrypto, independently of the engine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { groupIdFromGK, senderIdOf, msgMacKeyFromSecret, rosterMacKeyFromSecret } from '../lib/group.ts'
import { x25519FromPriv } from '../lib/x25519.ts'
import { subtle } from '../lib/wc.ts'

const KAT = JSON.parse(readFileSync(new URL('../../docs/kat/group-keys.json', import.meta.url), 'utf8'))
const unhex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

test('KAT: group id, sender ids, mk_ij, rk_i and the roster MAC match docs/kat/group-keys.json', async () => {
  const gk = await x25519FromPriv(unhex(KAT.gk_priv))
  const a = await x25519FromPriv(unhex(KAT.ik_priv.a))
  const b = await x25519FromPriv(unhex(KAT.ik_priv.b))
  const c = await x25519FromPriv(unhex(KAT.ik_priv.c))
  assert.equal(hex(gk.pub), KAT.gk_pub)
  const gid = await groupIdFromGK(gk.pub)
  assert.equal(hex(gid), KAT.group_id)
  assert.equal(hex(await senderIdOf(b64(a.pub))), KAT.sender_id.a)
  assert.equal(hex(await senderIdOf(b64(b.pub))), KAT.sender_id.b)
  assert.equal(hex(await senderIdOf(b64(c.pub))), KAT.sender_id.c)
  assert.ok(KAT.epochs.length >= 3)
  const seen = new Set<string>()
  for (const e of KAT.epochs) {
    const mkab = await msgMacKeyFromSecret(await a.dh(b.pub), gid, e.epoch)
    assert.equal(hex(mkab), e.mk_ab, `mk_ab at epoch ${e.epoch}`)
    assert.equal(hex(await msgMacKeyFromSecret(await b.dh(a.pub), gid, e.epoch)), e.mk_ab, 'mk_ij is the same from both ends')
    assert.equal(hex(await msgMacKeyFromSecret(await a.dh(c.pub), gid, e.epoch)), e.mk_ac, `mk_ac at epoch ${e.epoch}`)
    const rkb = await rosterMacKeyFromSecret(await gk.dh(b.pub), gid, e.epoch)
    assert.equal(hex(rkb), e.rk_b, `rk_b at epoch ${e.epoch}`)
    assert.equal(hex(await rosterMacKeyFromSecret(await b.dh(gk.pub), gid, e.epoch)), e.rk_b, 'rk_i is the same from GK and from the member')
    assert.deepEqual(e.roster, [a.pub, b.pub, c.pub].map(b64), 'roster is the base64 IK_pubs, admin first')
    const k = await subtle.importKey('raw', rkb, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const rmac = new Uint8Array(await subtle.sign('HMAC', k, new TextEncoder().encode(e.roster.join('\n'))))
    assert.equal(hex(rmac), e.rmac_b, `rmac at epoch ${e.epoch}`)
    // The epoch is in every key: no two epochs share one.
    for (const v of [e.mk_ab, e.mk_ac, e.rk_b]) { assert.ok(!seen.has(v), `a key repeats across epochs: ${v}`); seen.add(v) }
  }
  assert.notEqual(KAT.epochs[0].mk_ab, KAT.epochs[0].mk_ac, 'different pairs, different keys')
})
