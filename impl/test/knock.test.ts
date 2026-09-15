/**
 * The sealed knock (DISCOVERY-PROPOSAL.md §2.1).
 *
 * The round trip is the easy half. What the rest of this file pins is the three
 * properties the design actually rests on: every frame is the same length, a
 * decoy is indistinguishable from a real knock to anyone who cannot open it,
 * and a knock is bound to the invite it came through as well as to the
 * recipient.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sealKnock, decoyKnock, openKnock, FRAME_LEN, PLAIN_LEN, NAME_MAX, NOTE_MAX,
} from '../lib/knock.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { newInboxSecret, inboxSecretBytes } from '../lib/invite.ts'

const secret = () => inboxSecretBytes({ pub: '', name: '', inbox: newInboxSecret() })!

/** A Journalist: an identity keypair, used here the way the app uses `Identity`. */
const journalist = () => generateX25519()

test('a knock carries the key the Journalist could not derive, and opens', async () => {
  const j = await journalist()
  const s = secret()
  const src = await generateX25519()
  const frame = await sealKnock(s, j.pub, { ik: src.pub, name: 'Informator', note: 'mam dokumenty' })
  const got = await openKnock(s, j, frame)
  assert.ok(got && !got.decoy)
  assert.deepEqual([...(got as any).ik], [...src.pub])
  assert.equal((got as any).name, 'Informator')
  assert.equal((got as any).note, 'mam dokumenty')
})

test('EVERY frame is exactly the same length — a decoy must not be sortable by size', async () => {
  const j = await journalist()
  const s = secret()
  const src = await generateX25519()
  const frames = [
    await decoyKnock(s, j.pub),
    await sealKnock(s, j.pub, { ik: src.pub, name: '', note: '' }),
    await sealKnock(s, j.pub, { ik: src.pub, name: 'A', note: 'x' }),
    await sealKnock(s, j.pub, { ik: src.pub, name: 'Z'.repeat(NAME_MAX), note: 'y'.repeat(NOTE_MAX) }),
    await sealKnock(s, j.pub, { ik: src.pub, name: 'Z'.repeat(NAME_MAX * 4), note: 'y'.repeat(NOTE_MAX * 4) }),
  ]
  for (const f of frames) assert.equal(f.length, FRAME_LEN)
  assert.equal(new Set(frames.map((f) => f.length)).size, 1)
})

test('a decoy opens for the Journalist and says it is one; nothing else distinguishes it', async () => {
  const j = await journalist()
  const s = secret()
  const d = await decoyKnock(s, j.pub)
  const got = await openKnock(s, j, d)
  assert.deepEqual(got, { decoy: true })
})

test('two frames of the same content share no bytes — the ephemeral is per frame', async () => {
  const j = await journalist()
  const s = secret()
  const src = await generateX25519()
  const body = { ik: src.pub, name: 'Ala', note: 'to samo' }
  const a = await sealKnock(s, j.pub, body)
  const b = await sealKnock(s, j.pub, body)
  assert.notDeepEqual([...a], [...b], 'two knocks of identical content were byte-identical')
})

test('the binding holds: a knock from one invite does not open under another', async () => {
  // The cryptographer called this binding important (2026-09-15). Both invites
  // belong to the SAME Journalist, so the identity key cannot be what separates
  // them - only the invite secret in the HKDF info can.
  const j = await journalist()
  const one = secret(), two = secret()
  const src = await generateX25519()
  const frame = await sealKnock(one, j.pub, { ik: src.pub, name: 'Ala', note: '' })
  assert.ok(await openKnock(one, j, frame), 'its own invite must open it')
  assert.equal(await openKnock(two, j, frame), null, 'another invite of the same Journalist must not')
})

test('a knock addressed to somebody else does not open', async () => {
  const j = await journalist()
  const other = await journalist()
  const s = secret()
  const src = await generateX25519()
  const frame = await sealKnock(s, j.pub, { ik: src.pub, name: 'Ala', note: '' })
  assert.equal(await openKnock(s, other, frame), null)
})

test('malformed input returns null and never throws — the topic is public', async () => {
  const j = await journalist()
  const s = secret()
  const src = await generateX25519()
  const good = await sealKnock(s, j.pub, { ik: src.pub, name: 'Ala', note: '' })

  assert.equal(await openKnock(s, j, new Uint8Array(0)), null, 'empty')
  assert.equal(await openKnock(s, j, good.subarray(0, FRAME_LEN - 1)), null, 'truncated')
  assert.equal(await openKnock(s, j, new Uint8Array(FRAME_LEN)), null, 'all zeros')
  assert.equal(await openKnock(s, j, new Uint8Array(FRAME_LEN + 1)), null, 'too long')

  const flipped = good.slice(); flipped[FRAME_LEN - 1] ^= 1
  assert.equal(await openKnock(s, j, flipped), null, 'a flipped tag bit')
  const tampered = good.slice(); tampered[0] ^= 1     // the ephemeral key itself
  assert.equal(await openKnock(s, j, tampered), null, 'a flipped ephemeral bit')
})

test('an over-long name or note is cut on a character boundary, never mid-character', async () => {
  const j = await journalist()
  const s = secret()
  const src = await generateX25519()
  // Four bytes each, so a naive byte slice at NAME_MAX would land inside one.
  const emoji = '\u{1F510}'.repeat(40)
  const frame = await sealKnock(s, j.pub, { ik: src.pub, name: emoji, note: emoji })
  const got: any = await openKnock(s, j, frame)
  assert.ok(got && !got.decoy)
  assert.ok(!got.name.includes('�'), 'the name was cut mid-character')
  assert.ok(!got.note.includes('�'), 'the note was cut mid-character')
  assert.ok(Buffer.byteLength(got.name) <= NAME_MAX && Buffer.byteLength(got.note) <= NOTE_MAX)
  assert.ok(got.name.length > 0, 'it should keep what fits, not empty the field')
})

test('the plaintext is padded to a constant, so the wire size is a constant too', () => {
  assert.equal(FRAME_LEN, 32 + PLAIN_LEN + 16)
})
