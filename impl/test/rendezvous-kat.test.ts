/**
 * docs/kat/rendezvous.json and docs/kat/store-names.json, reproduced from
 * their inputs (SPEC.md §5.1-5.5, §5.10, §10). Nothing on the wire carries
 * these values for two implementations to compare - a topic one byte off is
 * an empty room, a storage name one byte off is a profile that does not open -
 * so the vectors are the only cross-check a second implementation has.
 * scripts/export-kat.mjs writes them; this file only reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { x25519FromPriv } from '../lib/x25519.ts'
import { kdf } from '../lib/wc.ts'
import {
  ANNOUNCE_LABEL, ROTATION_LABEL, paramsInfo, rotationCtx, topicFromSecret, groupTopicFromSecret,
  rotationOffsetSec, announceKeyFromMaterial,
} from '../lib/rendezvous.ts'
import { verifyAnnounce } from '../lib/announce.ts'
import { DECOY_SEED_LABEL, decoyMaterial } from '../lib/decoy.ts'
import { NAMES_LABEL, namesFromKey } from '../lib/storenames.ts'
import { hemKid } from '../lib/descr.ts'

const RV = JSON.parse(readFileSync(new URL('../../docs/kat/rendezvous.json', import.meta.url), 'utf8'))
const SN = JSON.parse(readFileSync(new URL('../../docs/kat/store-names.json', import.meta.url), 'utf8'))
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)))
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
const P = { networkId: RV.network_id, dateUTC: RV.date_utc }

test('KAT rendezvous: the pair secret, topic, Announce key and rotation offset (§5.1, §5.4, §5.5)', async () => {
  const a = await x25519FromPriv(unhex(RV.ik_priv.a)), b = await x25519FromPriv(unhex(RV.ik_priv.b))
  assert.equal(hex(a.pub), RV.ik_pub.a)
  const ss = await a.dh(b.pub)
  assert.equal(hex(ss), RV.pair.ss)
  assert.equal(hex(await b.dh(a.pub)), RV.pair.ss, 'both sides of the pair derive it')
  assert.equal(await topicFromSecret(ss, P), RV.pair.topic)
  assert.equal(hex(await kdf(ANNOUNCE_LABEL, ss, paramsInfo(P))), RV.pair.announce_key)
  assert.equal(hex(await kdf(ROTATION_LABEL, ss, rotationCtx(P.networkId), 4)), RV.pair.rotation_material)
  assert.equal(await rotationOffsetSec(ss, P), RV.pair.rotation_offset_sec)
})

test('KAT rendezvous: a recorded Announce verifies under the derived key, and not under another (§5.5)', async () => {
  const key = await announceKeyFromMaterial(unhex(RV.pair.announce_key))
  const frame = new TextEncoder().encode(JSON.stringify(RV.announce))
  assert.equal((await verifyAnnounce(frame, key, RV.announce.ts)).ok, true)
  const other = await announceKeyFromMaterial(new Uint8Array(32).fill(1))
  assert.equal((await verifyAnnounce(frame, other, RV.announce.ts)).reason, 'mac')
})

test('KAT rendezvous: the self-topic, a group topic and the decoys (§5.2, §5.3, §5.10)', async () => {
  const a = await x25519FromPriv(unhex(RV.ik_priv.a))
  const selfSs = await a.dh(a.pub)
  assert.equal(hex(selfSs), RV.self.ss)
  assert.equal(await topicFromSecret(selfSs, P), RV.self.topic)
  assert.equal(await rotationOffsetSec(selfSs, P), RV.self.rotation_offset_sec)
  assert.equal(await groupTopicFromSecret(unhex(RV.group.group_secret), P), RV.group.topic)
  const seed = await kdf(DECOY_SEED_LABEL, selfSs, rotationCtx(P.networkId), 32)
  assert.equal(hex(seed), RV.decoy.seed)
  assert.ok(RV.decoy.cases.length >= 3, 'the vector lost its decoy cases')
  for (const c of RV.decoy.cases) {
    const got = await decoyMaterial(seed, c.i, P)
    assert.equal(got.topic, c.topic, `decoy ${c.i} topic`)
    assert.equal(got.offsetSec, c.offsetSec, `decoy ${c.i} offset`)
  }
})

test('KAT store names: nk and every record name of an identity (§10)', async () => {
  const a = await x25519FromPriv(unhex(SN.ik_priv))
  const nk = await kdf(NAMES_LABEL, await a.dh(a.pub), new TextEncoder().encode('local storage names'), 32)
  assert.equal(hex(nk), SN.nk)
  const kid = await hemKid(a.pub)
  assert.equal(kid, SN.kid)
  const names = await namesFromKey(nk, kid)
  assert.equal(names.prefix, SN.prefix)
  assert.deepEqual(names.fixed, SN.fixed)
  assert.equal(await names.scoped('pin', SN.pin.scope), SN.pin.name)
  assert.equal(await names.scoped('group', SN.group.scope), SN.group.name)
  for (const n of Object.values(names.fixed)) assert.ok(!n.includes(kid), 'no name carries the KID')
})
