/**
 * file-decrypt.ts — fetch a shared file from the store and open it by hand.
 *
 * This exists to make the claim checkable rather than asked for on trust: the
 * store holds ciphertext, and the key that opens it travelled somewhere else
 * entirely — inside the envelope, over the ratchet or a group sender key.
 *
 * Run it against a real upload and the run prints, in order: the bytes the node
 * actually holds, the fact that the plaintext is nowhere in them, and the
 * original file recovered. Then run it again with `--no-key` and watch the same
 * blob stay opaque.
 *
 *   # ?debug=1 in the app logs one line per file: "file evidence | {...}"
 *   node net/file-decrypt.ts '{"cid":"Qm...","key":"...","chunk":4194304,"chunks":2,"size":5242880,"alg":"A256GCM-chunked-v1","name":"raport.pdf"}'
 *   node net/file-decrypt.ts '<same json>' --no-key      # the negative control
 *
 *   --out <path>       where to write the plaintext (default: a fresh temp dir,
 *                      printed on the last line — never the working directory)
 *   --origin <url>     app origin whose /f proxy to read through (default https://onchato.com)
 *   --gateway <url>    read from an IPFS gateway instead — proves the blob is
 *                      the same bytes whichever door you come through
 *
 * A 404 means the file expired. That is ordinary: uploads live minutes by
 * design, and this tool cannot resurrect one.
 */

import { decryptBytes, type FileManifest } from '../lib/filecrypto.ts'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name: string) => argv.includes(name)

const json = argv.find((a) => a.trim().startsWith('{'))
if (!json) {
  console.error('usage: node net/file-decrypt.ts \'<evidence json from ?debug=1>\' [--no-key] [--out f] [--origin url | --gateway url]')
  process.exit(2)
}

const ev = JSON.parse(json)
for (const k of ['cid', 'chunk', 'chunks', 'size', 'alg']) {
  if (ev[k] === undefined) { console.error(`the evidence line is missing "${k}"`); process.exit(2) }
}

const gateway = flag('--gateway')
const origin = (flag('--origin') ?? 'https://onchato.com').replace(/\/$/, '')
const url = gateway ? `${gateway.replace(/\/$/, '')}/ipfs/${ev.cid}` : `${origin}/f/${ev.cid}`

console.log(`cid       ${ev.cid}`)
console.log(`source    ${url}`)
console.log(`manifest  ${ev.chunks} x ${ev.chunk} B, ${ev.size} B plaintext, ${ev.alg}`)

const res = await fetch(url)
if (res.status === 404 || res.status === 410) {
  console.error('\nthe file is gone — uploads expire in minutes by design')
  process.exit(1)
}
if (!res.ok) { console.error(`\nfetch failed: HTTP ${res.status}`); process.exit(1) }
const cipher = new Uint8Array(await res.arrayBuffer())

// The tag is 16 B per chunk, so ciphertext is always longer than plaintext by
// exactly that much. Stating it here makes a truncated fetch obvious before the
// AEAD reports it as something that reads like a wrong key.
console.log(`\nfetched   ${cipher.length} B of ciphertext (${ev.size} B plaintext + ${ev.chunks} x 16 B tags)`)
console.log(`first 32  ${Buffer.from(cipher.subarray(0, 32)).toString('hex')}`)

if (has('--no-key')) {
  console.log('\n--no-key: this is everything the store, the proxy and anyone who')
  console.log('          intercepts the blob can see. There is nothing else in it.')
  process.exit(0)
}
if (!ev.key) { console.error('\nthe evidence line has no "key" — nothing to decrypt with'); process.exit(2) }

const manifest: FileManifest = { alg: ev.alg, chunk: ev.chunk, chunks: ev.chunks, size: ev.size }
let plain: Uint8Array
try {
  plain = await decryptBytes(Buffer.from(ev.key, 'base64'), manifest, cipher)
} catch (e: any) {
  console.error(`\ndecryption refused: ${e?.message ?? e}`)
  console.error('a wrong key, a tampered blob, a moved chunk and a truncated file all land here.')
  process.exit(1)
}

/**
 * Where the plaintext lands. Two rules, both learned the hard way.
 *
 * The name comes from the SENDER, so it is not a path and is not treated as
 * one: `../../.ssh/authorized_keys` in an envelope would otherwise write there,
 * with this tool's privileges, on a machine that merely inspected a file it was
 * sent. Only the last component survives, and a name that is nothing but
 * separators or dots is replaced outright.
 *
 * And the default is a fresh temp directory rather than the working one,
 * because the working one is usually inside this repository: a decrypted
 * private file appeared there once and sat one `git add -A` away from being
 * published. `--out` still writes exactly where it is told — that is a decision
 * someone made, not a name that arrived over the network.
 */
function destination(): string {
  const chosen = flag('--out')
  if (chosen) return resolve(chosen)
  const raw = typeof ev.name === 'string' ? basename(ev.name) : ''
  const safe = !raw || raw === '.' || raw === '..' || isAbsolute(raw) ? 'decrypted.bin' : raw
  return join(mkdtempSync(join(tmpdir(), 'ec-file-')), safe)
}

const out = destination()
// Caught rather than thrown: by this point the decryption has SUCCEEDED, and a
// stack trace about an unwritable path would read as if the crypto had failed.
try { writeFileSync(out, plain) }
catch (e: any) { console.error(`\ndecrypted ${plain.length} B but could not write ${out}: ${e?.message ?? e}`); process.exit(1) }
console.log(`\nrecovered ${plain.length} B -> ${out}`)

// The negative result matters as much as the positive one: the ciphertext was
// in hand the whole time and stayed useless until the key arrived from the
// envelope. Show it rather than assert it.
const probe = Buffer.from(plain.subarray(0, Math.min(16, plain.length)))
if (probe.length) {
  const leaks = Buffer.from(cipher).includes(probe)
  console.log(`plaintext present in the stored blob: ${leaks ? 'YES — that would be a bug' : 'no'}`)
}
