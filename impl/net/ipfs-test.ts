/**
 * ipfs-test.ts — a file through the real node, encrypted end to end.
 *
 * The unit tests prove the crypto and the parsing against an injected fetch.
 * What they cannot prove is that Kubo answers the way the client reads it —
 * `/add` returns line-delimited JSON whose shape has changed across versions,
 * `to-files` needs its parent to exist, and a CID is only useful if `cat`
 * returns exactly the bytes that went in. This asks the node.
 *
 *   node net/ipfs-test.ts                                  # through the app's own /f proxy
 *   node net/ipfs-test.ts --rpc https://rpc.ipfs.encedo.com  # straight at the node
 *
 * The `--rpc` form exists for the window before the proxy is deployed, and for
 * telling "the node is wrong" apart from "the proxy is wrong" afterwards. It
 * requires an IP the node allows; the proxy form does not, which is the point
 * of the proxy.
 *
 * It uploads a few hundred bytes of ciphertext that the expiry job collects
 * within minutes, and it verifies the MFS ledger entry when talking to the RPC
 * directly (the proxy deliberately cannot reach `files/*`).
 */

import { newFileKey, encryptBytes, decryptBytes } from '../lib/filecrypto.ts'
import { putBlob, getBlob, isCid } from './ipfs.ts'
import { randomBytes } from '../lib/wc.ts'

const args = process.argv.slice(2)
const rpc = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1]?.replace(/\/$/, '') : ''
const origin = args.includes('--origin') ? args[args.indexOf('--origin') + 1]?.replace(/\/$/, '') : 'https://onchato.com'
const CHUNK = 256 // small, so a modest payload still spans several chunks

let pass = 0, fail = 0
const ok = (c: boolean, msg: string, detail = '') => {
  if (c) { pass++; console.log(`  [ok] ${msg}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  [fail] ${msg}${detail ? ` — ${detail}` : ''}`) }
}
const step = (s: string) => console.log(`\n${s}`)

/**
 * When aimed at the RPC we speak Kubo's API directly; when aimed at an origin we
 * go through `/f`, which is what a browser does. Same assertions either way, so
 * a failure localises itself.
 */
const mfsName = `${Math.floor(Date.now() / 1000)}-livetest`
async function fetchThrough(input: string, init?: RequestInit): Promise<Response> {
  if (!rpc) return fetch(origin + input, init)
  if (input === '/f') return fetch(`${rpc}/api/v0/add?pin=false&to-files=/ec/${mfsName}`, { ...init, method: 'POST' })
  const cid = input.slice('/f/'.length)
  return fetch(`${rpc}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: 'POST' })
}

try {
  console.log(`target: ${rpc ? `${rpc} (RPC direct)` : `${origin} (via /f)`}`)

  step('encrypt')
  const plain = randomBytes(2000)
  const key = newFileKey()
  const { manifest, cipher } = await encryptBytes(key, plain, CHUNK)
  ok(manifest.chunks === Math.ceil(2000 / CHUNK), 'chunked as planned', `${manifest.chunks} x ${CHUNK} B`)
  ok(!Buffer.from(cipher).includes(Buffer.from(plain.subarray(0, 16))),
    'the blob carries no plaintext the store could read')

  step('upload')
  const { cid } = await putBlob(cipher, { fetchImpl: fetchThrough as any })
  ok(isCid(cid), 'a CID came back and parses', cid)

  step('fetch')
  const got = await getBlob(cid, { fetchImpl: fetchThrough as any })
  ok(got.length === cipher.length, 'byte count matches', `${got.length} B`)
  ok(Buffer.compare(Buffer.from(got), Buffer.from(cipher)) === 0, 'the bytes are identical')

  step('decrypt')
  const back = await decryptBytes(key, manifest, got)
  ok(Buffer.compare(Buffer.from(back), Buffer.from(plain)) === 0, 'round trip recovers the original')

  step('the wrong key gets nothing')
  let refused = false
  try { await decryptBytes(newFileKey(), manifest, got) } catch { refused = true }
  ok(refused, 'a blob fetched by CID is useless without the key from the envelope')

  if (rpc) {
    step('the expiry ledger')
    const ls = await (await fetch(`${rpc}/api/v0/files/ls?arg=/ec&long=true`, { method: 'POST' })).json() as any
    const entry = (ls.Entries ?? []).find((e: any) => e.Name === mfsName)
    ok(!!entry, 'the upload is listed in /ec under its timestamp', mfsName)
    ok(entry?.Hash === cid, 'and the ledger entry points at the CID we were given')
  }
} catch (e: any) {
  fail++
  console.log(`\n[fail] aborted: ${e?.message ?? e}`)
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`)
process.exit(fail ? 1 : 0)
