#!/usr/bin/env node
/**
 * release-manifest.mjs - sign what a client may trust for this release.
 *
 *   node scripts/release-manifest.mjs --sign ~/keys/onchato-root.key [--out <dir>] [--days 120]
 *   node scripts/release-manifest.mjs --verify <dir>
 *
 * Run AT the release commit with a fresh `npm run web:build` in impl/web/dist:
 * the manifest names the bundle's CID and SRI, the node list's CID, the CI
 * updater key and the commit, and the root key signs the file's exact bytes.
 * The output (manifest.json + manifest.sig) is served by the operator at
 * https://onchato.com/release/ from outside the repository, so that the
 * release commit can stay the tagged tip (the web deploy watches the tip).
 *
 * The root key never enters this repository or a CI runner. `infra/root.pub`
 * is its public half, compiled into every client (lib/manifest.ts).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cidV1Raw } from '../impl/lib/cid.ts'
import { signManifest, verifyManifest, rootPubOf } from '../impl/lib/manifest.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const rootPub = readFileSync(join(ROOT, 'infra', 'root.pub'), 'utf8').trim()

if (args.includes('--verify')) {
  const dir = opt('--verify', join(ROOT, 'infra', 'release'))
  const raw = new Uint8Array(readFileSync(join(dir, 'manifest.json')))
  const sig = readFileSync(join(dir, 'manifest.sig'), 'utf8')
  const v = verifyManifest(raw, sig, rootPub, Date.now())
  if (!v.ok) { console.error(`manifest: ${v.why}`); process.exit(1) }
  console.log(`manifest ok: v${v.manifest.version} (${v.manifest.commit}) until ${new Date(v.manifest.expires).toISOString()}`)
  process.exit(0)
}

const keyFile = opt('--sign')
if (!keyFile) { console.error('usage: --sign <root key file> [--out dir] [--days N] | --verify <dir>'); process.exit(2) }
const priv = readFileSync(keyFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l)).pop()
if (rootPubOf(priv) !== rootPub) { console.error('this key is not the one behind infra/root.pub'); process.exit(1) }

const pkg = JSON.parse(readFileSync(join(ROOT, 'impl', 'package.json'), 'utf8'))
const commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
const html = new Uint8Array(readFileSync(join(ROOT, 'impl', 'web', 'dist', 'index.html')))
const m = new TextDecoder().decode(html).match(/src="(app\.[a-f0-9]+\.bundle\.js)"[^>]*integrity="(sha384-[^"]+)"/)
if (!m) { console.error('index.html has no SRI on the bundle - build first'); process.exit(2) }
const nodes = new Uint8Array(readFileSync(join(ROOT, 'infra', 'nodes.json')))
const tauri = JSON.parse(readFileSync(join(ROOT, 'impl', 'src-tauri', 'tauri.conf.json'), 'utf8'))
const days = parseInt(opt('--days', '120'))
const made = Date.now()
const manifest = {
  v: 1, version: pkg.version, commit, made, expires: made + days * 86_400_000,
  web: { cid: await cidV1Raw(html), bundle: m[1], sri: m[2] },
  nodes: { cid: await cidV1Raw(nodes) },
  ci: { updater_pubkey: tauri.plugins?.updater?.pubkey ?? '' },
}
const raw = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
const out = opt('--out', join(ROOT, 'infra', 'release'))
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'manifest.json'), raw)
writeFileSync(join(out, 'manifest.sig'), signManifest(raw, priv) + '\n')
console.log(`signed v${manifest.version} (${commit}) -> ${out}/manifest.json + .sig, valid ${days} days`)
console.log(`  web   ${manifest.web.cid}  ${manifest.web.bundle}`)
console.log(`  nodes ${manifest.nodes.cid}`)
