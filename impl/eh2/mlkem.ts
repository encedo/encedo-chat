/**
 * eh2/mlkem.ts — the PQ half of EH-2's hybrid: ML-KEM-768 (FIPS 203).
 *
 * `SK = HKDF(dh1 || dh2 || dh3 || ss)` (§6.2): the three X25519 outputs rest on
 * ECDLP, `ss` rests on MLWE. SK confidentiality survives as long as **either**
 * assumption holds — the standard concatenation combiner (§6.4). A harvest-now-
 * decrypt-later adversary therefore has to break ML-KEM too, today, not in 2040.
 *
 * **Why a third-party library here and nowhere else:** WebCrypto has no ML-KEM.
 * The project rule is `crypto.subtle` wherever possible, so this is the single
 * exception — `@noble/post-quantum` (audited, dependency-light, the de-facto JS
 * implementation). Everything else in the handshake and ratchet stays WebCrypto.
 *
 * The keypair is **ephemeral, per handshake**, generated in the client — it is
 * deliberately NOT an HSM key (the HEM does have mlkemEncaps/Decaps, relevant
 * later for long-term PQ identity, §15 Phase 3, not for this per-session key).
 *
 * Sizes are FIPS 203 ML-KEM-768: pk 1184 B, ct 1088 B — the same constants
 * eh2/wire.ts enforces on the frames.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import type { Kem, KemKey } from './handshake.ts'

export const MLKEM768_SEED = 64

export const mlkem768: Kem = {
  name: 'ML-KEM-768',

  async generate(): Promise<KemKey> {
    const { publicKey, secretKey } = ml_kem768.keygen()
    return {
      pub: publicKey,
      async decapsulate(ct: Uint8Array): Promise<Uint8Array> {
        // FIPS 203 decapsulation never fails loudly: a bogus ciphertext yields
        // an unrelated (implicit-rejection) secret. That is fine here — the
        // handshake catches it as a MAC mismatch, not as an oracle.
        return ml_kem768.decapsulate(ct, secretKey)
      },
    }
  },

  async encapsulate(pub: Uint8Array): Promise<{ ct: Uint8Array; ss: Uint8Array }> {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(pub)
    return { ct: cipherText, ss: sharedSecret }
  },
}

/**
 * Deterministic variant for known-answer tests: the 64-byte seed fixes the
 * keypair. Never use a stored or reused seed in production — the EH-2 KEM key
 * must be fresh per handshake.
 */
export function mlkem768Seeded(seed: Uint8Array, encapMsg: Uint8Array): Kem {
  if (seed.length !== MLKEM768_SEED) throw new Error(`ML-KEM seed must be ${MLKEM768_SEED} B`)
  if (encapMsg.length !== 32) throw new Error('ML-KEM encapsulation message must be 32 B')
  return {
    name: 'ML-KEM-768 (seeded — tests only)',
    async generate() {
      const { publicKey, secretKey } = ml_kem768.keygen(seed)
      return { pub: publicKey, decapsulate: async (ct) => ml_kem768.decapsulate(ct, secretKey) }
    },
    async encapsulate(pub) {
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(pub, encapMsg)
      return { ct: cipherText, ss: sharedSecret }
    },
  }
}
