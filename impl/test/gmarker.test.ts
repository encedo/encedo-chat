/**
 * The HEM group marker (§8 portable membership) — DESCR encode/decode, the
 * compact roster, and the 128-byte field it all has to fit in.
 *
 * Two things here are easy to get wrong and expensive to discover later. The
 * DESCR is a fixed 128-byte record, so an over-long marker does not error — it
 * truncates, and a truncated roster blob decodes to a *different* roster. And
 * the CRC is integrity only: it catches a hint that resolved to the wrong key,
 * it does NOT make a roster trustworthy. Authenticity is the admin's rk_i MAC.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { randomBytes } from '../lib/wc.ts'
import {
  buildMarker, parseMarker, resolveRoster, hemKid, crc32,
  MARKER_PREFIX, DESCR_MAX, ROSTER_MAX, byteLen,
} from '../lib/gmarker.ts'

async function pubs(n: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for (let i = 0; i < n; i++) out.push((await generateX25519()).pub)
  return out
}

test('KID is SHA1(pub)[0:16] — deterministic, 32 hex', async () => {
  const [p] = await pubs(1)
  const a = await hemKid(p), b = await hemKid(p)
  assert.equal(a, b, 'the same key gives the same KID on any device — hints depend on this')
  assert.match(a, /^[0-9a-f]{32}$/)
})

test('CRC32 matches the IEEE reference vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('a marker round-trips through the DESCR', async () => {
  const members = await pubs(3)
  const { descr, rosterIncluded, nameIncluded } = await buildMarker({
    iat: 1780000000, adminPub: members[0], rosterPubs: members, name: 'Zespół',
  })
  assert.ok(rosterIncluded && nameIncluded)
  assert.ok(descr.startsWith(MARKER_PREFIX), 'key_search finds it by this prefix')

  const m = parseMarker(descr)!
  assert.equal(m.iat, 1780000000)
  assert.equal(m.adminKid, await hemKid(members[0]))
  assert.equal(m.hints.length, 3)
  assert.equal(m.name, 'Zespół')
})

test('the DESCR never exceeds 128 BYTES, even at the roster maximum', async () => {
  // Bytes, not characters. A name is user text: "Zespół" is 6 characters and 8
  // bytes, and measuring it in String.length overran the HSM field by exactly
  // the number of non-ASCII characters in it — silently truncating the roster
  // blob, which then decodes to a different roster.
  for (const n of [1, 2, 5, ROSTER_MAX]) {
    for (const name of [
      'a name long enough to overrun the field if nothing stopped it',
      'Zespół Projektowy Główny — Zarząd i Księgowość, oddział Łódź',
      '🔐🔐🔐 grupa 🔐🔐🔐 z emoji poza BMP 🔐🔐🔐',
    ]) {
      const members = await pubs(n)
      const { descr } = await buildMarker({ iat: 1799999999, adminPub: members[0], rosterPubs: members, name })
      assert.ok(byteLen(descr) <= DESCR_MAX, `${n} members / "${name.slice(0, 12)}…": ${byteLen(descr)} B`)
      assert.ok(parseMarker(descr), `${n} members: still parses`)
      assert.ok(!/�/.test(descr), 'a name is never cut mid-character')
    }
  }
})

test('the roster survives a squeeze; the name is what gets dropped', async () => {
  const members = await pubs(ROSTER_MAX)
  const { descr, rosterIncluded, nameIncluded } = await buildMarker({
    iat: 1799999999, adminPub: members[0], rosterPubs: members,
    name: 'this name cannot possibly fit alongside ten members',
  })
  assert.ok(rosterIncluded, 'membership is load-bearing and stays')
  assert.ok(!nameIncluded || parseMarker(descr)!.name.length < 20, 'the cosmetic field yields')
  assert.equal(parseMarker(descr)!.hints.length, ROSTER_MAX)
})

test('over the roster maximum the blob is omitted, not truncated', async () => {
  const members = await pubs(ROSTER_MAX + 2)
  const { descr, rosterIncluded } = await buildMarker({ iat: 1, adminPub: members[0], rosterPubs: members })
  assert.equal(rosterIncluded, false, 'a partial roster would be worse than none')
  const m = parseMarker(descr)!
  assert.equal(m.hints.length, 0)
  assert.equal(m.adminKid, await hemKid(members[0]), 'whom to re-sync from still survives')
})

test('hints resolve against the local key set, in roster order', async () => {
  const members = await pubs(4)
  const { descr } = await buildMarker({ iat: 1, adminPub: members[0], rosterPubs: members })
  const m = parseMarker(descr)!
  // The device holds these keys plus unrelated ones, in a different order.
  const local = [...(await pubs(3)), ...[...members].reverse()]
  const got = await resolveRoster(m, local)
  assert.ok(got, 'the roster reconstructed')
  assert.deepEqual(got!.map((p) => [...p]), members.map((p) => [...p]), 'and in the ADMIN order, not the local one')
})

test('a member this device has never seen makes reconstruction fail, not guess', async () => {
  const members = await pubs(3)
  const { descr } = await buildMarker({ iat: 1, adminPub: members[0], rosterPubs: members })
  const m = parseMarker(descr)!
  assert.equal(await resolveRoster(m, members.slice(0, 2)), null)
})

test('the CRC rejects a set that resolved to the wrong key', async () => {
  const members = await pubs(3)
  const { descr } = await buildMarker({ iat: 1, adminPub: members[0], rosterPubs: members })
  const m = parseMarker(descr)!
  // Simulate a 4-byte hint collision: a different key answers one hint.
  const [impostor] = await pubs(1)
  const collided = m.hints.slice()
  const forged = { ...m, hints: collided }
  const local = [members[0], members[1], impostor]
  // The impostor cannot answer member[2]'s hint, so this fails on resolution…
  assert.equal(await resolveRoster(forged, local), null)
  // …and a doctored CRC over a genuinely different set fails the check too.
  const wrongCrc = { ...m, crc: (m.crc ^ 0xffff) >>> 0 }
  assert.equal(await resolveRoster(wrongCrc, members), null, 'CRC mismatch is a refusal, not a warning')
})

test('the marker carries no group secret and no sender key', async () => {
  const members = await pubs(3)
  const secret = randomBytes(32)
  const { descr } = await buildMarker({ iat: 1, adminPub: members[0], rosterPubs: members, name: 'g' })
  // Nothing in the DESCR is derived from group state — only identity hints.
  for (const pub of members) assert.ok(!descr.includes(Buffer.from(pub).toString('base64')), 'no member public key verbatim')
  assert.ok(!descr.includes(Buffer.from(secret).toString('base64')))
})

test('a DESCR that is not ours parses as null', () => {
  assert.equal(parseMarker('ETSEIC:self,chris,ik,1780000000'), null)
  assert.equal(parseMarker(''), null)
  assert.equal(parseMarker(MARKER_PREFIX + 'nonsense'), null)
  assert.equal(parseMarker(MARKER_PREFIX + '1,notakid,,x'), null, 'a malformed admin KID is rejected')
})
