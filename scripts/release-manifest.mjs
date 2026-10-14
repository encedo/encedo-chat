#!/usr/bin/env node
/**
 * release-manifest.mjs - sign what a client may trust (ARCHITECTURE.md, Distribution).
 *
 * The manifest names the node list's CID, the CI updater key, the version and
 * commit it was made at, and an expiry; `--with-web` adds the web bundle's CID
 * and SRI (needs a fresh `npm run web:build`; nothing enforces it yet, see
 * lib/manifest.ts). It is signed when the node list or a CI key changes, or
 * before it expires - not per release - and served from outside the
 * repository at https://onchato.com/release/ (/var/lib/onchato/release/ on
 * the web host).
 *
 * Signing, by preference:
 *
 *   --sign-yubikey [--slot 9c]        the root key in a YubiKey PIV slot (firmware >= 5.7
 *                                     for Ed25519), through ykcs11 and pkcs11-tool:
 *                                     `apt install opensc ykcs11`; PIN and touch per signature.
 *   --unsigned                        write manifest.json only, to sign elsewhere; then
 *   --attach-sig <file>               take a detached signature (raw 64 bytes or base64) and
 *                                     write manifest.sig beside the manifest.
 *   --sign <keyfile>                  a key file (a test key; the file form the root key had
 *                                     before it moved into the token).
 *   --verify [dir]                    check manifest.json + .sig against infra/root.pub.
 *
 * The root key never enters this repository or a CI runner; `infra/root.pub`
 * is its public half, compiled into every client.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cidV1Raw } from '../impl/lib/cid.ts'
import { signManifest, verifyManifest, rootPubOf } from '../impl/lib/manifest.ts'
import { signFileYubikey } from './yubikey-sign.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const rootPub = readFileSync(join(ROOT, 'infra', 'root.pub'), 'utf8').trim()
const out = opt('--out', join(ROOT, 'infra', 'release'))
const b64 = (u) => Buffer.from(u).toString('base64')

const verify = (dir) => {
  const raw = new Uint8Array(readFileSync(join(dir, 'manifest.json')))
  const sig = readFileSync(join(dir, 'manifest.sig'), 'utf8')
  const v = verifyManifest(raw, sig, rootPub, Date.now())
  if (!v.ok) { console.error(`manifest: ${v.why}`); process.exit(1) }
  console.log(`manifest ok: v${v.manifest.version} (${v.manifest.commit}), nodes ${v.manifest.nodes.cid}${v.manifest.web ? ', web ' + v.manifest.web.cid : ''}, until ${new Date(v.manifest.expires).toISOString()}`)
}

if (has('--verify')) { verify(opt('--verify', out)); process.exit(0) }

if (has('--attach-sig')) {
  const f = readFileSync(opt('--attach-sig'))
  const sig = f.length === 64 ? b64(f) : f.toString('utf8').trim()
  if (Buffer.from(sig, 'base64').length !== 64) { console.error('that is not a 64-byte Ed25519 signature'); process.exit(1) }
  writeFileSync(join(out, 'manifest.sig'), sig + '\n')
  verify(out); process.exit(0)
}

if (!has('--sign') && !has('--sign-yubikey') && !has('--unsigned')) {
  console.error('usage: --sign-yubikey [--slot 9c] | --unsigned | --attach-sig <file> | --sign <keyfile> ; options: --out <dir> --days N --with-web ; --verify [dir]')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'impl', 'package.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim()
const nodes = new Uint8Array(readFileSync(join(ROOT, 'infra', 'nodes.json')))
const tauri = JSON.parse(readFileSync(join(ROOT, 'impl', 'src-tauri', 'tauri.conf.json'), 'utf8'))
const days = parseInt(opt('--days', '120'))
const made = Date.now()
const manifest = {
  v: 1, version: pkg.version, commit, made, expires: made + days * 86_400_000,
  nodes: { cid: await cidV1Raw(nodes) },
  ci: { updater_pubkey: tauri.plugins?.updater?.pubkey ?? '' },
}
if (has('--with-web')) {
  const html = new Uint8Array(readFileSync(join(ROOT, 'impl', 'web', 'dist', 'index.html')))
  const m = new TextDecoder().decode(html).match(/src="(app\.[a-f0-9]+\.bundle\.js)"[^>]*integrity="(sha384-[^"]+)"/)
  if (!m) { console.error('index.html has no SRI on the bundle - build first'); process.exit(2) }
  manifest.web = { cid: await cidV1Raw(html), bundle: m[1], sri: m[2] }
}
const raw = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'manifest.json'), raw)
console.log(`manifest v${manifest.version} (${commit}) -> ${out}/manifest.json, valid ${days} days; nodes ${manifest.nodes.cid}${manifest.web ? '; web ' + manifest.web.cid : ''}`)

if (has('--unsigned')) { console.log('unsigned: sign manifest.json elsewhere (pure Ed25519 over its bytes) and run --attach-sig'); process.exit(0) }

let sig
if (has('--sign-yubikey')) {
  try { sig = signFileYubikey(join(out, 'manifest.json'), { slot: opt('--slot', '9c'), module: opt('--module') }) }
  catch (e) { console.error(`[fail] ${e.message}`); process.exit(1) }
} else {
  const priv = readFileSync(opt('--sign'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l)).pop()
  if (rootPubOf(priv) !== rootPub) { console.error('this key is not the one behind infra/root.pub'); process.exit(1) }
  sig = signManifest(raw, priv)
}
writeFileSync(join(out, 'manifest.sig'), sig + '\n')
verify(out)
