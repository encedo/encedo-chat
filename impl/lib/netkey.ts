/**
 * netkey.ts - the stable libp2p key of an identity in a network that admits
 * devices by list (`policy.access: "allowlist"`, OPERATOR-NODE-PLAN.md, B).
 *
 * Everywhere else a session dials with a fresh key - a new PeerId every start,
 * nothing for a node to follow from one session to the next. In such a
 * network the node must recognise the device, so this identity keeps ONE key
 * for it: a pseudonym the node can put on its list, unrelated to the identity
 * key, proven by the Noise handshake (nothing secret travels).
 *
 * Sealed like the identity's other small stores (sealedstore.ts), one per
 * identity - two identities of one person in one network are two devices to
 * the node, never linked by a shared key. It belongs to THIS device: a profile
 * moved to another one (lib/migrate.ts) does not carry it, and the new device
 * is admitted on its own.
 */
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { readSealedKV, writeSealedKV } from './sealedstore.ts'
import type { Names } from './storenames.ts'
import type { KV } from './migrate.ts'
import { b64, unb64 } from './wc.ts'

interface Stored { k: string }
const isStored = (v: unknown): v is Stored => !!v && typeof (v as any).k === 'string'

/** The key's protobuf bytes (what libp2p's `privateKey` takes, via privateKeyFromProtobuf), made on first use. */
export async function loadOrCreateNetKey(kv: KV, base: Uint8Array | null, names: Names, log?: (m: string) => void): Promise<Uint8Array | null> {
  const held = await readSealedKV<Stored>(kv, base, names, 'netkey', isStored, log)
  if (held) {
    try { privateKeyFromProtobuf(unb64(held.k)); return unb64(held.k) } catch { log?.('netkey: the stored key does not open - keeping it, not replacing it'); return null }
  }
  // A record that is there but does not open (another base, a damaged write) is
  // NOT replaced: a new key is a new PeerId, off the node's list - the device
  // would lock itself out. Leave it for the person to sort out.
  if (kv.get(names.fixed.netkey)) { log?.('netkey: a stored key does not open - not replacing it'); return null }
  // Without a base nothing could be stored, and a key that is not kept would be a
  // new PeerId next time - one the node does not know. Say so; do not pretend.
  if (!base) { log?.('netkey: no cache base - no stable key'); return null }
  const raw = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
  await writeSealedKV(kv, base, names, 'netkey', { k: b64(raw) }, log)
  return raw
}

/** The PeerId a key's holder shows a node - what goes on the node's list. */
export const netPeerId = (raw: Uint8Array): string => peerIdFromPrivateKey(privateKeyFromProtobuf(raw)).toString()
