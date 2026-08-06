/**
 * filecrypto.ts — file bodies, encrypted in chunks before they ever leave.
 *
 * A file is AES-256-GCM under a **single-use random key**, split into chunks.
 * The key travels in the `file` envelope over the 1:1 ratchet or a group sender
 * key — both of which are already PQ-hybrid, because the EH-2 handshake seeds
 * them and ML-KEM-768 is one of its four inputs. So nothing post-quantum needs
 * adding here: a KEM per file would protect a key that is already protected.
 * The body itself is symmetric, and Grover leaves AES-256 at 128 bits.
 *
 * **Chunking is not an optimisation.** `subtle.encrypt` is a one-shot API: a
 * 128 MB file means the plaintext AND the ciphertext resident at once, ~256 MB
 * of peak allocation, which a phone will not survive. Chunks let the caller
 * stream and show progress.
 *
 * Three separate things could go wrong with a chunked file, and each is caught
 * by something different:
 *
 * | attack | what stops it |
 * |---|---|
 * | a chunk's bytes altered | the AEAD tag on that chunk |
 * | chunks reordered | the index is in the AAD, so chunk *i* only opens at *i* |
 * | the file truncated | the chunk COUNT is in the AAD as well, so every chunk names how many there should be |
 *
 * The manifest (chunk size, count, plaintext length) rides the same
 * authenticated envelope as the key, so a receiver knows what it should have
 * before it fetches anything. The CID is a hash of the ciphertext and also
 * arrives authenticated, which covers the whole blob independently.
 *
 * The nonce is `0x00000000 ‖ u64(index)`. A counter nonce is safe here for the
 * one reason that matters: the key is generated per file and never used again,
 * so an (key, nonce) pair cannot repeat.
 */

import { subtle, randomBytes } from './wc.ts'

/** Bytes of plaintext per chunk. 4 MiB: 32 chunks for a 128 MB file, 512 B of
 *  tags total, ~12 MB of peak allocation — small enough for a phone, coarse
 *  enough that a progress bar is not the expensive part. */
export const DEFAULT_CHUNK = 4 * 1024 * 1024

/** Bigger than this and a phone starts failing allocations rather than slowing down. */
export const MAX_CHUNK = 16 * 1024 * 1024
export const MAX_FILE = 128 * 1024 * 1024

const TAG = 16 // AES-GCM tag, appended by WebCrypto

/**
 * Everything a receiver needs to decrypt, besides the key. Travels in the
 * envelope, so it is authenticated before any byte is fetched.
 *
 * `chunk` is a WIRE FIELD, not a build constant: changing the default must not
 * break files already sent, and the receiver cannot guess it.
 */
export interface FileManifest {
  alg: 'A256GCM-chunked-v1'
  /** Plaintext bytes per chunk (the last one may be shorter). */
  chunk: number
  /** How many chunks the ciphertext must contain. */
  chunks: number
  /** Plaintext length in bytes. */
  size: number
}

export function planChunks(size: number, chunk = DEFAULT_CHUNK): FileManifest {
  if (!Number.isInteger(size) || size < 0) throw new Error('file size must be a non-negative integer')
  if (size > MAX_FILE) throw new Error(`file is ${size} B, limit is ${MAX_FILE} B`)
  if (!Number.isInteger(chunk) || chunk <= 0 || chunk > MAX_CHUNK) throw new Error(`chunk size out of range: ${chunk}`)
  // A zero-length file is one empty chunk, not zero chunks: it still needs a
  // tag, or "empty" and "truncated to nothing" would look the same.
  return { alg: 'A256GCM-chunked-v1', chunk, chunks: Math.max(1, Math.ceil(size / chunk)), size }
}

/** A fresh single-use key. Raw bytes because it has to travel in the envelope. */
export function newFileKey(): Uint8Array { return randomBytes(32) }

const key = (raw: Uint8Array) => {
  if (raw.length !== 32) throw new Error(`file key must be 32 B, got ${raw.length}`)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function nonce(index: number): Uint8Array {
  const n = new Uint8Array(12)
  new DataView(n.buffer).setBigUint64(4, BigInt(index), false)
  return n
}

/** `u32(index) ‖ u32(total)` — position and length, bound into every chunk. */
function aad(index: number, total: number): Uint8Array {
  const a = new Uint8Array(8)
  const v = new DataView(a.buffer)
  v.setUint32(0, index, false); v.setUint32(4, total, false)
  return a
}

/** Ciphertext length of a chunk, so a caller can validate before decrypting. */
export function chunkCipherLen(m: FileManifest, index: number): number {
  const plain = index === m.chunks - 1 ? m.size - index * m.chunk : m.chunk
  return Math.max(0, plain) + TAG
}

export async function encryptChunk(keyRaw: Uint8Array, m: FileManifest, index: number, plain: Uint8Array): Promise<Uint8Array> {
  if (index < 0 || index >= m.chunks) throw new Error(`chunk ${index} outside 0..${m.chunks - 1}`)
  const k = await key(keyRaw)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce(index), additionalData: aad(index, m.chunks) }, k, plain)
  return new Uint8Array(ct)
}

export async function decryptChunk(keyRaw: Uint8Array, m: FileManifest, index: number, ct: Uint8Array): Promise<Uint8Array> {
  if (index < 0 || index >= m.chunks) throw new Error(`chunk ${index} outside 0..${m.chunks - 1}`)
  const k = await key(keyRaw)
  // Throws on a bad tag, a wrong key, a moved chunk, or a manifest claiming a
  // different chunk count — all of them land here as the same refusal, which is
  // the right outcome: the caller must not get partial plaintext either way.
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce(index), additionalData: aad(index, m.chunks) }, k, ct)
  return new Uint8Array(pt)
}

/**
 * Whole-buffer convenience — for tests and small files. Big ones stream.
 *
 * `onProgress` exists because a 128 MB file is tens of chunks and several
 * seconds of work: without it the UI has nothing to report between "started"
 * and "done", which on a large file is indistinguishable from a freeze.
 */
export async function encryptBytes(
  keyRaw: Uint8Array, plain: Uint8Array, chunk = DEFAULT_CHUNK,
  onProgress?: (done: number, total: number) => void,
) {
  const m = planChunks(plain.length, chunk)
  const parts: Uint8Array[] = []
  for (let i = 0; i < m.chunks; i++) {
    parts.push(await encryptChunk(keyRaw, m, i, plain.subarray(i * m.chunk, (i + 1) * m.chunk)))
    onProgress?.(i + 1, m.chunks)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return { manifest: m, cipher: out }
}

export async function decryptBytes(keyRaw: Uint8Array, m: FileManifest, cipher: Uint8Array): Promise<Uint8Array> {
  if (m.alg !== 'A256GCM-chunked-v1') throw new Error(`unknown file algorithm: ${m.alg}`)
  const expect = Array.from({ length: m.chunks }, (_, i) => chunkCipherLen(m, i)).reduce((a, b) => a + b, 0)
  // Checked before touching the AEAD: a short blob is a truncated fetch, and
  // saying so beats a decrypt failure that looks like a wrong key.
  if (cipher.length !== expect) throw new Error(`ciphertext is ${cipher.length} B, manifest says ${expect} B`)
  const out = new Uint8Array(m.size)
  let ctAt = 0, ptAt = 0
  for (let i = 0; i < m.chunks; i++) {
    const len = chunkCipherLen(m, i)
    const pt = await decryptChunk(keyRaw, m, i, cipher.subarray(ctAt, ctAt + len))
    out.set(pt, ptAt); ctAt += len; ptAt += pt.length
  }
  return out
}
