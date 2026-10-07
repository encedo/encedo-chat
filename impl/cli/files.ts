/**
 * files.ts - sending and receiving files from the terminal (CLI-PLAN.md stage 5).
 *
 * The app's construction, the app's code (PROTOCOL.md §7.5): a fresh key per
 * file, chunked AES-GCM (lib/filecrypto.ts), the ciphertext uploaded to the
 * store (net/ipfs.ts, onchato.com/f - the store prepends an 8-byte envelope,
 * lib/fileenvelope.ts), and a `file` envelope over the ratchet carrying the CID
 * and the key. The store sees ciphertext and its size; the name, the type and
 * the key travel only inside the conversation.
 *
 * The store keeps a blob about five minutes. A file that was not fetched in
 * time is gone - said so, never pretended.
 */

import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { newFileKey, encryptBytes, decryptBytes, MAX_FILE, type FileManifest } from '../lib/filecrypto.ts'
import { unwrapBlob } from '../lib/fileenvelope.ts'
import { putBlob, getBlob, setStoreOrigin } from '../net/ipfs.ts'
import type { FileMeta } from '../lib/envelope.ts'

/** The store lives on the product's site, as for the packaged apps (app.ts SITE_ORIGIN). */
setStoreOrigin(process.env.ONCHATO_STORE ?? 'https://onchato.com')

export const FILE_TTL_MS = 5 * 60_000   // the app's value: the store sweeps after ~5 min
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.mp4': 'video/mp4',
}
export const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'

export const humanSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1048576).toFixed(1)} MB`

/** Encrypt and upload a file; the meta to hand to `sendFile`. */
export async function prepareFile(path: string, onStage?: (s: string) => void): Promise<FileMeta> {
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`${path} nie jest plikiem`)
  if (st.size > MAX_FILE) throw new Error(`plik ma ${humanSize(st.size)} - limit to ${humanSize(MAX_FILE)}`)
  const key = newFileKey()
  onStage?.('szyfruję')
  const { manifest, cipher } = await encryptBytes(key, new Uint8Array(readFileSync(path)))
  onStage?.('wysyłam do magazynu')
  const { cid } = await putBlob(cipher)
  return {
    cid, name: basename(path), size: st.size, mime: mimeOf(path),
    key: b64(key), chunk: manifest.chunk, chunks: manifest.chunks, alg: manifest.alg,
    exp: Date.now() + FILE_TTL_MS,
  } as FileMeta
}

/**
 * A received name made safe for a disk: no directories, no control or path
 * characters, never empty, never a dot-file by accident.
 */
export function safeName(name: string): string {
  const s = basename(String(name)).replace(/[\p{Cc}\p{Cf}\/\\:*?"<>|]/gu, '_').replace(/^\.+/, '').trim().slice(0, 200)
  return s || 'plik'
}

/** `dir/name`, or `dir/name (2).ext` ... - an existing file is never overwritten. */
export function freePath(dir: string, name: string): string {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length)
  let p = join(dir, name), i = 2
  while (existsSync(p)) p = join(dir, `${stem} (${i++})${ext}`)
  return p
}

export function downloadDir(): string {
  if (process.env.ONCHATO_DOWNLOADS) return process.env.ONCHATO_DOWNLOADS
  for (const d of ['Pobrane', 'Downloads']) if (existsSync(join(homedir(), d))) return join(homedir(), d)
  return process.cwd()
}

/** Fetch, open and save a received file; the path it was saved to. */
export async function saveFile(meta: FileMeta, dir = downloadDir(), now = Date.now()): Promise<string> {
  if (meta.exp && now > meta.exp) throw new Error('plik wygasł - magazyn trzyma pliki ok. 5 minut; poproś o ponowne wysłanie')
  const cipher = unwrapBlob(await getBlob(meta.cid))
  const m: FileManifest = { alg: meta.alg, size: meta.size, chunk: meta.chunk, chunks: meta.chunks } as FileManifest
  let plain: Uint8Array
  try { plain = await decryptBytes(Uint8Array.from(Buffer.from(meta.key, 'base64')), m, cipher) }
  catch { throw new Error('nie da się odszyfrować pliku - zły klucz albo uszkodzona treść (nic nie zapisano)') }
  mkdirSync(dir, { recursive: true })
  const path = freePath(dir, safeName(meta.name))
  writeFileSync(path, plain, { mode: 0o600 })
  return path
}
