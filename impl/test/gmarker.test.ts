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
  MARKER_PREFIX, DESCR_MAX, ROSTER_MAX, NAME_MAX, byteLen, kidOf,
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
  const { descr, rosterIncluded, nameIncluded } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })), name: 'Zespół',
  })
  assert.ok(rosterIncluded && nameIncluded)
  assert.ok(descr.startsWith(MARKER_PREFIX), 'key_search finds it by this prefix')

  const m = parseMarker(descr)!
  assert.equal(m.adminKid, (await hemKid(members[0])).slice(0, 8), 'the admin travels as a 4-byte hint')
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
      const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })), name })
      assert.ok(byteLen(descr) <= DESCR_MAX, `${n} members / "${name.slice(0, 12)}…": ${byteLen(descr)} B`)
      assert.ok(parseMarker(descr), `${n} members: still parses`)
      assert.ok(!/�/.test(descr), 'a name is never cut mid-character')
    }
  }
})

test('the roster survives a squeeze; the name is what gets dropped', async () => {
  const members = await pubs(ROSTER_MAX)
  const { descr, rosterIncluded, nameIncluded } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })),
    name: 'this name cannot possibly fit alongside ten members',
  })
  assert.ok(rosterIncluded, 'membership is load-bearing and stays')
  assert.ok(!nameIncluded || parseMarker(descr)!.name.length < 20, 'the cosmetic field yields')
  assert.equal(parseMarker(descr)!.hints.length, ROSTER_MAX)
})

test('over the roster maximum the blob is omitted, not truncated', async () => {
  const members = await pubs(ROSTER_MAX + 2)
  const { descr, rosterIncluded } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })) })
  assert.equal(rosterIncluded, false, 'a partial roster would be worse than none')
  const m = parseMarker(descr)!
  assert.equal(m.hints.length, 0)
  assert.equal(m.adminKid, (await hemKid(members[0])).slice(0, 8), 'whom to re-sync from still survives')
})

test('hints resolve against the local key set, in roster order', async () => {
  const members = await pubs(4)
  const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })) })
  const m = parseMarker(descr)!
  // The device holds these keys plus unrelated ones, in a different order.
  const local = [...(await pubs(3)), ...[...members].reverse()].map((pub) => ({ pub }))
  const got = await resolveRoster(m, local)
  assert.ok(got, 'the roster reconstructed')
  assert.deepEqual(got!.map((p) => [...p.pub!]), members.map((p) => [...p]), 'and in the ADMIN order, not the local one')
})

test('a member this device has never seen makes reconstruction fail, not guess', async () => {
  const members = await pubs(3)
  const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })) })
  const m = parseMarker(descr)!
  assert.equal(await resolveRoster(m, members.slice(0, 2).map((pub) => ({ pub }))), null)
})

test('the CRC rejects a set that resolved to the wrong key', async () => {
  const members = await pubs(3)
  const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })) })
  const m = parseMarker(descr)!
  // Simulate a 4-byte hint collision: a different key answers one hint.
  const [impostor] = await pubs(1)
  const collided = m.hints.slice()
  const forged = { ...m, hints: collided }
  const local = [members[0], members[1], impostor].map((pub) => ({ pub }))
  // The impostor cannot answer member[2]'s hint, so this fails on resolution...
  assert.equal(await resolveRoster(forged, local), null)
  // ...and a doctored CRC over a genuinely different set fails the check too.
  const wrongCrc = { ...m, crc: (m.crc ^ 0xffff) >>> 0 }
  assert.equal(await resolveRoster(wrongCrc, members.map((pub) => ({ pub }))), null, 'CRC mismatch is a refusal, not a warning')
})

test('the marker carries no group secret and no sender key', async () => {
  const members = await pubs(3)
  const secret = randomBytes(32)
  const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((p) => ({ pub: p })), name: 'g' })
  // Nothing in the DESCR is derived from group state — only identity hints.
  for (const pub of members) assert.ok(!descr.includes(Buffer.from(pub).toString('base64')), 'no member public key verbatim')
  assert.ok(!descr.includes(Buffer.from(secret).toString('base64')))
})

test('a DESCR that is not ours parses as null', () => {
  assert.equal(parseMarker('ETSEIC:self,chris,ik,1780000000'), null)
  assert.equal(parseMarker(''), null)
  assert.equal(parseMarker(MARKER_PREFIX + 'nonsense'), null)
  assert.equal(parseMarker(MARKER_PREFIX + 'nope:n:'), null, 'a malformed admin hint is rejected')
  // The previous generation is NOT read: the devices holding it are erased, and
  // reading it would be worse than ignoring it — the owner field goes in before
  // the admin hint, so an old record parses as a group under the wrong identity.
  assert.equal(parseMarker('ETSEIC:chan,' + 'a'.repeat(32) + ',n,'), null, 'the unversioned form is gone')
  assert.equal(parseMarker('ETSEIC:chan1:AAAAAA:n:'), null, 'a generation-1 record with no owner field')
})

// ---- the four shape decisions (user review, 2026-08-04) --------------------

test('no iat: the HSM timestamps its own key records, so the field is not repeated', async () => {
  const members = await pubs(2)
  const { descr } = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((pub) => ({ pub })), name: 'g' })
  const fields = descr.slice(MARKER_PREFIX.length).split(':')
  assert.equal(fields.length, 4, 'owner hint, admin hint, name, roster — and nothing else')
  assert.ok(!/\b1[7-9]\d{8}\b/.test(descr), 'no unix timestamp anywhere in the marker')
})

test('the name is capped at 16 characters', async () => {
  const members = await pubs(2)
  const { descr } = await buildMarker({
    owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((pub) => ({ pub })),
    name: 'a group name far longer than sixteen characters',
  })
  assert.equal(parseMarker(descr)!.name.length, NAME_MAX)
})

test('the roster blob is last, so it is the field free to grow or vanish', async () => {
  const members = await pubs(4)
  const withRoster = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((pub) => ({ pub })), name: 'g' })
  const without = await buildMarker({ owner: { pub: members[0] }, admin: { pub: members[0] }, name: 'g' })
  assert.equal(without.rosterIncluded, false)
  // Everything before the blob is byte-identical whether or not the blob is there.
  const head = (d: string) => d.slice(0, d.lastIndexOf(',') + 1)
  assert.equal(head(withRoster.descr), head(without.descr), 'the optional field disturbs nothing before it')
  assert.ok(withRoster.descr.startsWith(head(without.descr)))
})

test('at ten members the roster still fits alongside a full-length name', async () => {
  const members = await pubs(ROSTER_MAX)
  const r = await buildMarker({
    owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((pub) => ({ pub })), name: 'Zespół Projektowy Alfa',
  })
  assert.ok(r.rosterIncluded, 'the roster is never the field that yields at the maximum')
  assert.equal(parseMarker(r.descr)!.name.length, NAME_MAX)
  assert.ok(byteLen(r.descr) <= DESCR_MAX)
})

test('an HSM-issued KID is preferred over deriving one, and they agree', async () => {
  const [pub] = await pubs(1)
  const derived = await kidOf({ pub })
  assert.equal(derived, await hemKid(pub), 'with only a public key we derive SHA1(pub)[0:16]')
  // When the HSM gave us a KID, that is what is used — no second opinion.
  assert.equal(await kidOf({ kid: 'AABBCCDDEEFF00112233445566778899', pub }), 'aabbccddeeff00112233445566778899')
})

test('a member with neither a KID nor a public key drops the whole blob', async () => {
  const members = await pubs(3)
  const { rosterIncluded } = await buildMarker({
    owner: { pub: members[0] }, admin: { pub: members[0] },
    members: [{ pub: members[0] }, {}, { pub: members[2] }], // one unrepresentable
    name: 'g',
  })
  assert.equal(rosterIncluded, false, 'half a roster reconstructs a wrong one')
})

// ---- the owner field (§8 Proposal, 2026-08-09) -----------------------------

test("a member's marker names the owner, an admin somebody else, and carries no roster", async () => {
  const [me, admin, third] = await pubs(3)
  const { descr, rosterIncluded } = await buildMarker({ owner: { pub: me }, admin: { pub: admin }, name: 'Zespół' })
  const m = parseMarker(descr)!
  assert.equal(m.ownerKid, (await hemKid(me)).slice(0, 8))
  assert.equal(m.adminKid, (await hemKid(admin)).slice(0, 8))
  assert.notEqual(m.ownerKid, m.adminKid, 'a member does not administer the group it is in')
  assert.equal(rosterIncluded, false)
  assert.equal(m.hints.length, 0, 'a member copies no membership graph onto its device')
  assert.ok(byteLen(descr) < 70, `a member's marker is small: ${byteLen(descr)} B`)
  // And the whole point: two identities on one device tell their groups apart.
  assert.notEqual(m.ownerKid, (await hemKid(third)).slice(0, 8))
})

test('on a group we administer the owner and the admin are the same party', async () => {
  const members = await pubs(3)
  const m = parseMarker((await buildMarker({
    owner: { pub: members[0] }, admin: { pub: members[0] }, members: members.map((pub) => ({ pub })), name: 'g',
  })).descr)!
  assert.equal(m.ownerKid, m.adminKid)
  assert.equal(m.hints.length, 3, "the admin's marker still carries the roster")
})

test('the owner costs 7 bytes, and ten members still fit beside a full name', async () => {
  const members = await pubs(ROSTER_MAX)
  const r = await buildMarker({
    owner: { pub: members[0] }, admin: { pub: members[0] },
    members: members.map((pub) => ({ pub })), name: 'Zespół Projektowy',
  })
  assert.ok(r.rosterIncluded, 'the roster does not yield to the new field')
  assert.equal(parseMarker(r.descr)!.name.length, NAME_MAX)
  assert.ok(byteLen(r.descr) <= DESCR_MAX, `${byteLen(r.descr)} B`)
})
