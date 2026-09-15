/**
 * knock.ts — one sealed frame that says "here is my key" on a public topic.
 *
 * The frame a Source publishes on a Journalist's inbox topic
 * (DISCOVERY-PROPOSAL.md §2.1). Its shape is EH-2's `msg1`: a one-shot
 * ephemeral public key in the clear, everything else sealed to the recipient's
 * identity key. Nothing new is introduced — X25519, HKDF-SHA256 and AES-GCM,
 * all of them already on the message path.
 *
 * ## Why the ephemeral key is not decoration
 *
 * The inbox topic is named by a secret PRINTED ON A WEB PAGE, so unlike every
 * other topic in this protocol it is public: anyone who read the page can
 * subscribe to it. Put the Source's identity key in the clear and the first
 * person to scrape the invite learns who answered it. With the ephemeral, an
 * observer sees a random public key and a ciphertext — that somebody knocked,
 * when, and how big the frame was. Not who. §6.1 of the proposal is explicit
 * that this is traffic analysis rather than deanonymization, and that for a
 * Journalist and a Source traffic analysis can still be enough.
 *
 * ## Why every frame is the same length
 *
 * `FRAME_LEN` is a constant and the plaintext is padded to `PLAIN_LEN` before
 * it is sealed. Two things depend on it and both are lost the moment a frame's
 * size varies: a decoy stops being indistinguishable from a real knock, which
 * is the whole of the §6.1 mitigation, and the length of what somebody wrote
 * stops being private. Padding is therefore not an optimisation to revisit.
 *
 * ## The binding to the invite
 *
 * The invite secret is the HKDF `info`, so a knock is bound to the invite it
 * came through as well as to the recipient — a frame sealed for one invite
 * does not open under another even though both are addressed to the same
 * identity key. The cryptographer confirmed the schedule and called the
 * binding important (2026-09-15).
 */

import { hkdfBits, subtle } from './wc.ts'
import { generateX25519, type Dh } from './x25519.ts'

const te = new TextEncoder()
const td = new TextDecoder()

/** HKDF salt. Versioned: a later frame shape must not open under this key. */
const LABEL = te.encode('encedo-chat-invite-knock-v1')

/** Longest display name a knock carries, in BYTES — the wire budget is bytes,
 *  and a name arrives as UTF-8 from a stranger. */
export const NAME_MAX = 64
/** Longest note. Enough for a sentence saying why; not a message channel —
 *  the conversation starts once the knock is accepted. */
export const NOTE_MAX = 200

const IK_LEN = 32
const EPH_LEN = 32
const TAG_LEN = 16
const KEY_LEN = 32
const NONCE_LEN = 12

/** kind | ik | nameLen | name | noteLen(2) | note — fixed, zero-padded. */
export const PLAIN_LEN = 1 + IK_LEN + 1 + NAME_MAX + 2 + NOTE_MAX
/** What goes on the wire, always. */
export const FRAME_LEN = EPH_LEN + PLAIN_LEN + TAG_LEN

const KIND_DECOY = 0x00
const KIND_REAL = 0x01

export type Knock =
  /** Cover traffic. The recipient drops it; an observer cannot tell it apart. */
  | { decoy: true }
  | { decoy: false; ik: Uint8Array; name: string; note: string }

/**
 * Key and nonce for one frame.
 *
 * A fresh ephemeral per frame means this key seals exactly once, so the nonce
 * is derived rather than carried — the same reasoning §8 states for a sender
 * key's single-use MK, and it keeps twelve bytes off a frame whose length is
 * itself load-bearing.
 */
async function frameKey(shared: Uint8Array, inbox: Uint8Array) {
  const bits = await hkdfBits(shared, LABEL, inbox, KEY_LEN + NONCE_LEN)
  return { raw: bits.subarray(0, KEY_LEN), nonce: bits.subarray(KEY_LEN) }
}

/** Cut a string to fit `max` BYTES without splitting a character. */
function fitBytes(s: string, max: number): Uint8Array {
  let out = te.encode(s)
  if (out.length <= max) return out
  // Step back by code points, not by array index: slicing UTF-8 mid-sequence
  // produces bytes that decode to a replacement character on the other side.
  const chars = [...s]
  while (chars.length && out.length > max) { chars.pop(); out = te.encode(chars.join('')) }
  return out
}

function pack(kind: number, ik: Uint8Array, name: string, note: string): Uint8Array {
  const p = new Uint8Array(PLAIN_LEN)
  p[0] = kind
  if (ik.length === IK_LEN) p.set(ik, 1)
  const n = fitBytes(name, NAME_MAX)
  p[1 + IK_LEN] = n.length
  p.set(n, 2 + IK_LEN)
  const t = fitBytes(note, NOTE_MAX)
  const at = 2 + IK_LEN + NAME_MAX
  p[at] = (t.length >> 8) & 0xff
  p[at + 1] = t.length & 0xff
  p.set(t, at + 2)
  return p
}

function unpack(p: Uint8Array): Knock | null {
  if (p.length !== PLAIN_LEN) return null
  if (p[0] === KIND_DECOY) return { decoy: true }
  if (p[0] !== KIND_REAL) return null            // a kind we do not know is not a knock
  const nameLen = p[1 + IK_LEN]
  const at = 2 + IK_LEN + NAME_MAX
  const noteLen = (p[at] << 8) | p[at + 1]
  // Lengths come from inside the seal, so they are not attacker-chosen in the
  // usual sense - but a peer running a different build is, so they are checked.
  if (nameLen > NAME_MAX || noteLen > NOTE_MAX) return null
  return {
    decoy: false,
    ik: p.slice(1, 1 + IK_LEN),
    name: td.decode(p.subarray(2 + IK_LEN, 2 + IK_LEN + nameLen)),
    note: td.decode(p.subarray(at + 2, at + 2 + noteLen)),
  }
}

async function seal(inbox: Uint8Array, toPub: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const eph = await generateX25519()
  const { raw, nonce } = await frameKey(await eph.dh(toPub), inbox)
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain))
  const out = new Uint8Array(FRAME_LEN)
  out.set(eph.pub, 0)
  out.set(ct, EPH_LEN)
  return out
}

/**
 * "Here is my key, let me in." `ik` is the Source's own identity public key —
 * the one thing the Journalist cannot derive and the only reason this frame
 * exists.
 */
export function sealKnock(
  inbox: Uint8Array,
  journalistPub: Uint8Array,
  body: { ik: Uint8Array; name: string; note?: string },
): Promise<Uint8Array> {
  return seal(inbox, journalistPub, pack(KIND_REAL, body.ik, body.name, body.note ?? ''))
}

/**
 * Cover traffic, published by the Journalist's own client on its own inbox.
 *
 * It is a real frame under a real ephemeral key, not random bytes: anyone can
 * tell noise from an AEAD frame by its length alone, and the point is that
 * "a knock happened" stops carrying information because it happens anyway. It
 * doubles as the keepalive an otherwise silent topic needs, since the relay
 * evicts a topic idle for 120 s (§6.1).
 */
export function decoyKnock(inbox: Uint8Array, journalistPub: Uint8Array): Promise<Uint8Array> {
  return seal(inbox, journalistPub, pack(KIND_DECOY, new Uint8Array(IK_LEN), '', ''))
}

/**
 * Open a frame addressed to us, or return null.
 *
 * Null for every failure and never a throw: this reads bytes off a PUBLIC topic
 * that anyone holding the invite can publish to, so malformed and hostile input
 * is the ordinary case, not the exception. `dh` is the recipient's identity —
 * `dhFromEcdh(id.pub, id.ecdh)` for a HEM or a software profile alike.
 */
export async function openKnock(inbox: Uint8Array, dh: Dh, frame: Uint8Array): Promise<Knock | null> {
  if (frame.length !== FRAME_LEN) return null
  try {
    const { raw, nonce } = await frameKey(await dh.dh(frame.subarray(0, EPH_LEN)), inbox)
    const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, frame.subarray(EPH_LEN)))
    return unpack(plain)
  } catch { return null }
}
