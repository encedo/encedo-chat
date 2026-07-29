/**
 * toy-kem.ts — a stand-in KEM for the EH-2 tests. **TEST ONLY, NOT SECURE.**
 *
 * It has the shape of ML-KEM-768 (same key/ciphertext sizes, same
 * encapsulate/decapsulate contract) so the handshake's key schedule can be
 * exercised end-to-end before the real thing lands in stage 3 — but its "shared
 * secret" is a hash of two public seeds, which provides no confidentiality
 * whatsoever. It exists to prove the `ss` slot is wired to both sides
 * identically; stage 3 swaps in `@noble/post-quantum` behind the same `Kem`.
 */

import { sha256, concat, randomBytes } from '../lib/wc.ts'
import { MLKEM768_PK, MLKEM768_CT } from '../eh2/wire.ts'
import type { Kem } from '../eh2/handshake.ts'

export function toyKem(rand: (n: number) => Uint8Array = randomBytes): Kem {
  return {
    name: 'toy-kem (TEST ONLY — not post-quantum, not secure)',
    async generate() {
      const seed = rand(32)
      const pub = new Uint8Array(MLKEM768_PK)
      pub.set(seed)
      return { pub, decapsulate: (ct) => sha256(concat(seed, ct.slice(0, 32))) }
    },
    async encapsulate(pub) {
      const r = rand(32)
      const ct = new Uint8Array(MLKEM768_CT)
      ct.set(r)
      return { ct, ss: await sha256(concat(pub.slice(0, 32), r)) }
    },
  }
}

/** Deterministic filler for known-answer tests: byte i of run n = i*7 + n. */
export function seededRand(): (n: number) => Uint8Array {
  let call = 0
  return (n: number) => {
    call++
    return Uint8Array.from({ length: n }, (_, i) => (i * 7 + call * 13) & 0xff)
  }
}
