#!/usr/bin/env node
/**
 * approve-web.mjs - the final approval of a web release: build the tag here,
 * check that three CIDs agree, sign the manifest that names it with the root
 * key in the YubiKey, put it on the host, and check what the host now serves.
 *
 *   node scripts/approve-web.mjs --host <name> <tag>     PIN + touch, the rest is automatic
 *   node scripts/approve-web.mjs <tag>                   lists the hosts and asks
 *   ... --dry-run                                        every check, no signature, no upload
 *
 * A tag publishes a web build that works and is not yet verifiable; this makes
 * it verifiable (docs/REPRODUCIBLE.md, ARCHITECTURE.md Distribution). Nothing
 * is signed unless all of these hold:
 *   1. a clean build of the tag HERE gives a CID;
 *   2. CI's build of the same tag gave the same CID (reproducible-<tag>.md on
 *      the GitHub release - two builds CI already compared);
 *   3. the host serves that CID (waits up to --wait minutes for the deploy);
 *   4. the host's current manifest verifies under the host's root key, and the
 *      new one changes nothing but the web entry, version, commit and dates -
 *      a node list or an updater key is never changed from here
 *      (release-manifest.mjs is for that);
 *   5. the key in the token is the host's root key (the fresh signature is
 *      verified against it before anything is uploaded).
 *
 * Which host means which manifest, key and upload path is the operator's, not
 * the repository's: ~/.config/onchato-ops/hosts/<name>.json
 *   {
 *     "web":      "https://app.onchato.com/",
 *     "manifest": "https://onchato.com/release/manifest.json",
 *     "upload":   "bs1.onchato.com:/var/lib/onchato/release/",
 *     "root_pub": "<base64 Ed25519 public key>",
 *     "slot":     "9c"
 *   }
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { cidV1Raw } from '../impl/lib/cid.ts'
import { verifyManifest } from '../impl/lib/manifest.ts'
import { signFileYubikey, yubikeyPreflight } from './yubikey-sign.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOSTS = join(homedir(), '.config', 'onchato-ops', 'hosts')
const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--host', '--wait', '--days', '--module', '--ci-cid'].includes(args[i - 1])))
const DRY = has('--dry-run')

const step = (m) => console.log(`\n== ${m}`)
const ok = (m) => console.log(`[ok]   ${m}`)
const fail = (m) => { console.error(`[fail] ${m}`); cleanup(); process.exit(1) }
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { encoding: 'utf8', ...o }).trim()

let worktree = null
function cleanup() {
  if (!worktree) return
  try { run('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, stdio: 'ignore' }) } catch {}
  try { rmSync(worktree, { recursive: true, force: true }) } catch {}
  worktree = null
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const htmlChain = async (bytes) => {
  const m = new TextDecoder().decode(bytes).match(/src="(app\.[a-f0-9]+\.bundle\.js)"[^>]*integrity="(sha384-[^"]+)"/)
  if (!m) fail('index.html carries no SRI on its bundle - the chain is incomplete')
  return { cid: await cidV1Raw(bytes), bundle: m[1], sri: m[2] }
}

// ---- the host -----------------------------------------------------------------
let hostName = opt('--host')
const hostsKnown = existsSync(HOSTS) ? readdirSync(HOSTS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []
if (!hostName) {
  if (!hostsKnown.length) fail(`no host configured - create ${HOSTS}/<name>.json (see the header of this script)`)
  console.log('hosts:'); hostsKnown.forEach((h, i) => console.log(`  ${i + 1}) ${h}`))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question('which host? ')).trim(); rl.close()
  hostName = hostsKnown[Number(a) - 1] ?? a
}
const hostFile = join(HOSTS, `${hostName}.json`)
if (!existsSync(hostFile)) fail(`unknown host "${hostName}" - no ${hostFile}`)
const host = JSON.parse(readFileSync(hostFile, 'utf8'))
for (const k of ['web', 'manifest', 'upload', 'root_pub']) if (!host[k]) fail(`${hostFile} has no "${k}"`)
const tag = positional[0]
if (!tag) fail('usage: approve-web.mjs [--host <name>] <tag> [--dry-run] [--wait <min>] [--days <n>]')
console.log(`approving ${tag} for ${hostName} (${host.web})${DRY ? ' - DRY RUN, nothing is signed or uploaded' : ''}`)

if (!DRY) {
  const missing = yubikeyPreflight(opt('--module'))
  if (missing.length) fail(`cannot sign on this machine, missing: ${missing.join(', ')}`)
}

// ---- 1. a clean build of the tag here -----------------------------------------
step('1/5 build the tag here, in a worktree of its own')
run('git', ['fetch', '--quiet', '--tags', 'origin'], { cwd: ROOT })
let commit
try { commit = run('git', ['rev-list', '-n', '1', tag], { cwd: ROOT }) } catch { fail(`no tag ${tag}`) }
worktree = mkdtempSync(join(tmpdir(), `approve-${tag}-`))
rmSync(worktree, { recursive: true, force: true })
run('git', ['worktree', 'add', '--detach', '--quiet', worktree, commit], { cwd: ROOT })
run('git', ['submodule', 'update', '--init', '--recursive', '--quiet'], { cwd: worktree })
for (const [cmd, argv] of [['npm', ['ci', '--no-audit', '--no-fund']], ['npm', ['run', 'web:build']]]) {
  // A clean environment for the build: EC_ALLOW_KEYS must be what the deploy
  // and CI use (unset), or the CID differs and step 2 fails for a wrong reason.
  const env = { ...process.env }; delete env.EC_ALLOW_KEYS
  const r = spawnSync(cmd, argv, { cwd: join(worktree, 'impl'), env, stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) fail(`${cmd} ${argv.join(' ')} failed in the worktree`)
}
const builtHtml = new Uint8Array(readFileSync(join(worktree, 'impl', 'web', 'dist', 'index.html')))
const built = await htmlChain(builtHtml)
const version = JSON.parse(readFileSync(join(worktree, 'impl', 'package.json'), 'utf8')).version
ok(`${tag} (${commit.slice(0, 8)}, v${version}) builds to ${built.cid}`)

// ---- 2. CI built the same -----------------------------------------------------
step('2/5 CI built the same')
let ciCid = opt('--ci-cid')
if (!ciCid) {
  let md = null
  try { md = run('gh', ['release', 'download', tag, '--repo', 'encedo/encedo-chat', '--pattern', `reproducible-${tag}.md`, '--output', '-'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }) } catch {}
  if (!md) {
    try { const r = await fetch(`https://github.com/encedo/encedo-chat/releases/download/${tag}/reproducible-${tag}.md`); if (r.ok) md = await r.text() } catch {}
  }
  if (!md) fail(`no reproducible-${tag}.md on the release (gh not signed in and the release not public?) - pass --ci-cid <cid> after reading it by hand`)
  ciCid = md.match(/GitHub runner[^|]*\|\s*`([a-z0-9]+)`/)?.[1]
  if (!ciCid) fail(`reproducible-${tag}.md names no runner CID`)
}
if (ciCid !== built.cid) fail(`CI built ${ciCid}, this machine built ${built.cid} - the builds differ; nothing is signed`)
ok(`CI built ${ciCid} too`)

// ---- 3. the host serves it ----------------------------------------------------
step('3/5 the host serves it')
const waitMs = Number(opt('--wait', '20')) * 60_000
const t0 = Date.now()
let served = null
for (;;) {
  try { const r = await fetch(host.web, { cache: 'no-store' }); if (r.ok) served = await cidV1Raw(new Uint8Array(await r.arrayBuffer())) } catch {}
  if (served === built.cid) break
  if (Date.now() - t0 > waitMs) fail(`after ${Math.round((Date.now() - t0) / 60_000)} min ${host.web} serves ${served ?? 'nothing'}, not ${built.cid}`)
  console.log(`  serves ${served ?? 'nothing'} - waiting for the deploy...`)
  await new Promise((r) => setTimeout(r, 30_000))
}
ok(`${host.web} serves ${served}`)

// ---- 4. the new manifest ------------------------------------------------------
step('4/5 the manifest')
const getBytes = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) fail(`${u} -> HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()) }
const curRaw = await getBytes(host.manifest)
const curSig = new TextDecoder().decode(await getBytes(host.manifest.replace(/\.json$/, '.sig'))).trim()
const cur = verifyManifest(curRaw, curSig, host.root_pub, Date.now())
let current
if (cur.ok) current = cur.manifest
else if (cur.why === 'expired') { current = JSON.parse(new TextDecoder().decode(curRaw)); console.log('  the current manifest has expired - renewing it here') }
else fail(`the host's current manifest does not verify under its root key (${cur.why})`)
// Nothing but the web entry moves from here: the node list and the updater key
// at the tag must be what the host already signs.
const tagNodes = await cidV1Raw(new Uint8Array(readFileSync(join(worktree, 'infra', 'nodes.json'))))
const tagUpdater = JSON.parse(readFileSync(join(worktree, 'impl', 'src-tauri', 'tauri.conf.json'), 'utf8')).plugins?.updater?.pubkey ?? ''
if (tagNodes !== current.nodes.cid) fail(`the tag's node list (${tagNodes}) is not the signed one (${current.nodes.cid}) - change it with release-manifest.mjs, not here`)
if (tagUpdater !== current.ci.updater_pubkey) fail('the tag trusts another updater key than the signed manifest names - change it with release-manifest.mjs, not here')
const repoRoot = readFileSync(join(worktree, 'infra', 'root.pub'), 'utf8').trim()
if (repoRoot !== host.root_pub.trim()) console.log(`  WARNING: ${hostName}'s root_pub is not the infra/root.pub this tag's clients carry`)
const days = Number(opt('--days', '120'))
const made = Date.now()
const next = { ...current, version, commit: commit.slice(0, 7), made, expires: made + days * 86_400_000, web: built }
const out = mkdtempSync(join(tmpdir(), `approve-out-${tag}-`))
const raw = new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n')
writeFileSync(join(out, 'manifest.json'), raw)
ok(`manifest v${version} (${next.commit}): web ${built.cid}, nodes ${next.nodes.cid} unchanged, valid ${days} days`)

if (DRY) { console.log(`\nDRY RUN: manifest written to ${out}/manifest.json, not signed, not uploaded.`); cleanup(); process.exit(0) }

// ---- 5. sign, check, upload, check again --------------------------------------
step('5/5 sign (PIN, then touch the key), upload, check')
let sig
try { sig = signFileYubikey(join(out, 'manifest.json'), { slot: host.slot ?? '9c', module: opt('--module') }) }
catch (e) { fail(`${e.message}\n       The build is done and the manifest is ready; run this again with the key in to sign - nothing was uploaded.`) }
const mine = verifyManifest(raw, sig, host.root_pub, Date.now())
if (!mine.ok) fail(`the fresh signature does not verify under ${hostName}'s root key (${mine.why}) - wrong token or wrong slot; nothing was uploaded`)
writeFileSync(join(out, 'manifest.sig'), sig + '\n')
ok('signed, and the signature verifies under the host root key')

const [sshHost, dir] = host.upload.split(':')
// Upload beside the live files, then rename: no reader ever gets half a file.
run('scp', ['-q', join(out, 'manifest.json'), `${sshHost}:${dir}/manifest.json.new`])
run('scp', ['-q', join(out, 'manifest.sig'), `${sshHost}:${dir}/manifest.sig.new`])
run('ssh', [sshHost, `mv ${dir}/manifest.json.new ${dir}/manifest.json && mv ${dir}/manifest.sig.new ${dir}/manifest.sig`])
ok(`uploaded to ${host.upload}`)

const liveRaw = await getBytes(host.manifest)
const liveSig = new TextDecoder().decode(await getBytes(host.manifest.replace(/\.json$/, '.sig'))).trim()
const live = verifyManifest(liveRaw, liveSig, host.root_pub, Date.now())
if (!live.ok) fail(`the manifest the host now serves does not verify (${live.why})`)
if (live.manifest.web?.cid !== served) fail(`the live manifest names ${live.manifest.web?.cid}, the host serves ${served}`)
ok(`${host.manifest} verifies and names ${served}, which ${host.web} serves`)
cleanup()
console.log(`\n${tag} approved for ${hostName}.`)
