#!/usr/bin/env node
/**
 * onchato-ops.mjs - the operator's one command: release signing (ours) and the
 * network profile of an operator running its own network (anyone's).
 *
 *   release manifest ...           = release-manifest.mjs (node list CID, updater key)
 *   release approve-web <tag> ...  = approve-web.mjs (the web build of a tag)
 *
 *   network key  --yubikey [--slot 9c] | --file <keyfile> | --passphrase <root.kdf> | --passphrase-new <root.kdf>
 *       the root key's public half and fingerprint; `--file` on a path that does
 *       not exist yet makes a NEW key there (mode 0600, never overwritten);
 *       `--passphrase-new` derives one from a passphrase (Argon2id, private salt;
 *       lib/signer.mjs) and keeps only salt + public key
 *   network sign <profile.json> --sign-yubikey [--slot 9c] | --sign <keyfile> | --sign-passphrase <root.kdf>
 *                [--nodes nodes.json] [--seq N] [--days 120] [--out network.json] [--root-pub <b64>]
 *       fills rootPub, seq, made, expires (and nodes from a node list file),
 *       checks the result the way an app will, signs the exact bytes, and opens
 *       the written envelope again before saying ok. Without --seq: one above
 *       the --out file's when it is there under the same key, else 1.
 *   network link <https://.../network.json> <network.json> [--svg qr.svg] [--png qr.png]
 *       the pointer an app scans (the URL + the file's CID) and its QR code -
 *       the full envelope does not fit a QR code, the pointer does
 *   network check <network.json | pointer link> [--online]
 *       what an app would show on import, and with --online (always for a
 *       link) what each profileUrl serves, including the CORS header the app
 *       needs to fetch it
 *
 *   access seed|qr|list|revoke|label|unlock [--dir /data/allow]
 *       a network that admits devices by list (relay/enroll.mjs): the TOTP seed and
 *       the QR for the administrator's authenticator (8 digits - Google
 *       Authenticator, Aegis, 2FAS; not Microsoft's, which shows 6), the devices on
 *       the list, taking one off, a note on one, and unlocking enrolment after
 *       too many wrong codes. On a node: docker run ... onchato-ops access ...
 *
 * The release scripts stay where they are (CLAUDE.md and relay/DEPLOY.md call
 * them by name); this routes to them.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signerFrom, newKeyFile, newPassphraseKey, readKdf, readSecret } from './lib/signer.mjs'
import { publicKeyYubikey } from './yubikey-sign.mjs'
import { parseOperatorProfile, openEnvelope, rootFingerprint, pointerFor, parseNetworkPointer, fetchPointed } from '../impl/lib/netprofile.ts'
import { qrMatrix, qrSvg } from '../impl/lib/qr.ts'
import { qrForTerminal } from '../impl/cli/termqr.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const [group, cmd, ...args] = process.argv.slice(2)
const has = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const WITH_VALUE = ['--dir', '--label', '--png', '--slot', '--module', '--file', '--passphrase', '--passphrase-new', '--sign-passphrase', '--sign', '--nodes', '--seq', '--days', '--out', '--svg', '--root-pub']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && WITH_VALUE.includes(args[i - 1])))
const fail = (m) => { console.error(`[fail] ${m}`); process.exit(1) }
const DAY = 86_400_000
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

const USAGE = `usage:
  onchato-ops release manifest [release-manifest.mjs options]
  onchato-ops release approve-web <tag> [approve-web.mjs options]
  onchato-ops network key   --yubikey [--slot 9c] | --file <keyfile> | --passphrase[-new] <root.kdf>
  onchato-ops network sign  <profile.json> --sign-yubikey [--slot 9c] | --sign <keyfile> | --sign-passphrase <root.kdf> [--nodes nodes.json] [--seq N] [--days 120] [--out network.json]
  onchato-ops network link  <https://.../network.json> <network.json> [--svg qr.svg] [--png qr.png]
  onchato-ops network check <network.json | link> [--online]
  onchato-ops access seed|qr [--label <name>] [--png f]|list|revoke <peer>|label <peer> <text>|unlock [--dir /data/allow]`

// ---- release: the existing scripts ------------------------------------------
if (group === 'release') {
  const script = { manifest: 'release-manifest.mjs', 'approve-web': 'approve-web.mjs' }[cmd]
  if (!script) fail(`unknown release command ${cmd ?? ''}\n${USAGE}`)
  try { execFileSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' }) } catch (e) { process.exit(e.status ?? 1) }
  process.exit(0)
}
// ---- access: devices admitted by list --------------------------------------------
if (group === 'access') {
  const dir = opt('--dir', '/data/allow')
  const listFile = `${dir}/peers.txt`, seedFile = `${dir}/totp.seed`
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const b32 = (buf) => { let bits = '', out = ''; for (const x of buf) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out }
  const lines = () => { try { return readFileSync(listFile, 'utf8').split('\n') } catch { return [] } }
  const entries = () => lines().map((l, i) => { const m = l.match(/^\s*(12D3KooW\S+)\s*([^#]*?)\s*(?:#\s*(.*))?$/); return m ? { i, id: m[1], label: m[2], note: m[3] ?? '' } : null }).filter(Boolean)
  const write = (ls) => { mkdirSync(dir, { recursive: true }); writeFileSync(listFile + '.tmp', ls.join('\n').replace(/\n*$/, '\n')); renameSync(listFile + '.tmp', listFile) }
  const pick = (q) => {
    const hits = entries().filter((e) => e.id === q || (q.length >= 6 && e.id.endsWith(q)))
    if (hits.length !== 1) fail(hits.length ? `"${q}" matches ${hits.length} devices - give more of the PeerId` : `no device "${q}" on the list`)
    return hits[0]
  }
  const uri = (label) => `otpauth://totp/${encodeURIComponent('onchato:' + label)}?secret=${readFileSync(seedFile, 'utf8').trim()}&issuer=onchato&algorithm=SHA1&digits=8&period=30`
  switch (cmd) {
    case 'seed':
      if (existsSync(seedFile) && !has('--new')) { console.log(`[ok] ${seedFile} exists (--new replaces it: every authenticator must then scan again)`); process.exit(0) }
      mkdirSync(dir, { recursive: true }); writeFileSync(seedFile, b32(randomBytes(20)) + '\n', { mode: 0o600 })
      console.log(`[ok] a new enrolment seed in ${seedFile}`); process.exit(0)
    case 'qr': {
      if (!existsSync(seedFile)) fail(`no seed in ${dir} (access seed)`)
      const u = uri(opt('--label', 'network'))
      console.log('Scan with an authenticator that shows 8 digits (Google Authenticator, Aegis, 2FAS - not Microsoft Authenticator):')
      console.log(qrForTerminal(u))
      if (opt('--png')) { writeFileSync(opt('--png'), qrPng(u, 8)); console.log(`[ok] the same as a picture: ${opt('--png')}`) }
      process.exit(0)
    }
    case 'list': {
      const es = entries()
      console.log(`${es.length} device(s) on the list (${listFile})`)
      for (const e of es) console.log(`  ${e.id.slice(-12)}  ${(e.label || '-').padEnd(24)} ${e.note}`)
      if (existsSync(`${dir}/enroll.locked`)) console.log(`WARNING: enrolment is LOCKED since ${readFileSync(`${dir}/enroll.locked`, 'utf8').trim()} - access unlock`)
      let f = 0; try { f = Number(readFileSync(`${dir}/enroll.failures`, 'utf8')) || 0 } catch {}
      if (f) console.log(`${f} wrong code(s) since the last unlock`)
      process.exit(0)
    }
    case 'revoke': {
      const e = pick(positional[0] ?? fail('which device? (access list)'))
      const ls = lines(); ls.splice(e.i, 1); write(ls)
      console.log(`[ok] ${e.id.slice(-12)} ${e.label} taken off the list - the node drops it within seconds`); process.exit(0)
    }
    case 'label': {
      const e = pick(positional[0] ?? fail('which device?'))
      const text = positional.slice(1).join(' ').replace(/[^\p{L}\p{N} ._,()-]/gu, '').slice(0, 60)
      const ls = lines(); ls[e.i] = `${e.id} ${text}${e.note ? ' # ' + e.note : ''}`; write(ls)
      console.log(`[ok] ${e.id.slice(-12)} is now "${text}"`); process.exit(0)
    }
    case 'unlock':
      for (const f of ['enroll.locked', 'enroll.failures']) { try { unlinkSync(`${dir}/${f}`) } catch {} }
      console.log('[ok] enrolment unlocked, the wrong-code count reset'); process.exit(0)
    default: fail(`unknown access command ${cmd ?? ''}\n${USAGE}`)
  }
}

if (group !== 'network') { console.error(USAGE); process.exit(group ? 1 : 0) }

/** What an app shows a person on import, plus what an operator wants to see. */
async function describe(profile) {
  const days = Math.floor((profile.expires - Date.now()) / DAY)
  console.log(`  network   ${profile.networkId}`)
  console.log(`  operator  ${profile.operator}`)
  console.log(`  root key  ${await rootFingerprint(profile.rootPub)}   (people compare this)`)
  console.log(`  seq       ${profile.seq}`)
  console.log(`  valid     ${day(profile.made)} .. ${day(profile.expires)} (${days >= 0 ? `${days} days left` : 'EXPIRED'})`)
  console.log(`  nodes     ${profile.nodes.length}: ${profile.nodes.map((n) => n.name ?? n.addr).join(', ')}`)
  console.log(`  app       ${profile.app.origin}${profile.app.path}`)
  console.log(`  stores    ${profile.stores.join(', ')}`)
  console.log(`  refresh   ${profile.profileUrls.join(', ')}`)
  console.log(`  feedback  ${profile.feedback ?? '(none - the app shows no form)'}`)
  const pol = Object.entries(profile.policy).map(([k, v]) => `${k}=${v && typeof v === 'object' ? Object.values(v).join(',') : v}`).join(' ')
  console.log(`  policy    ${pol || '(none)'}`)
  if (days >= 0 && days < 30) console.log(`WARNING: expires in ${days} days - re-sign with a higher seq and upload before then`)
}

function openOrFail(text, label) {
  const r = openEnvelope(text, Date.now(), undefined, { allowExpired: true })
  if (!r.ok) fail(`${label}: refused (${r.why}${r.detail ? `: ${r.detail}` : ''})`)
  return r
}

/** A QR code as a grayscale PNG (an SVG does not open everywhere - a phone's
 *  gallery, some chat apps). Quiet zone of 4 modules, `scale` pixels each. */
function qrPng(text, scale = 10) {
  const m = qrMatrix(text), q = 4, n = m.length, W = (n + 2 * q) * scale
  const raw = Buffer.alloc((W + 1) * W)
  for (let y = 0; y < W; y++) {
    const my = Math.floor(y / scale) - q
    for (let x = 0; x < W; x++) {
      const mx = Math.floor(x / scale) - q
      raw[y * (W + 1) + 1 + x] = my >= 0 && mx >= 0 && my < n && mx < n && m[my][mx] === 1 ? 0 : 255
    }
  }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---- network key -----------------------------------------------------------
if (cmd === 'key') {
  let pub
  if (has('--yubikey')) pub = publicKeyYubikey({ slot: opt('--slot', '9c'), module: opt('--module') })
  else if (opt('--file')) {
    const file = opt('--file')
    if (existsSync(file)) pub = signerFrom((n, d) => (n === '--sign' ? file : d), () => false).pub()
    else { pub = newKeyFile(file); console.log(`[ok] a new root key in ${file} (mode 600) - keep a copy offline; losing it means a new network`) }
  } else if (opt('--passphrase-new')) {
    const file = opt('--passphrase-new')
    const a = await readSecret('New network key passphrase: ')
    if (process.stdin.isTTY && a !== await readSecret('The same again: ')) fail('the two passphrases differ - nothing written')
    try { pub = newPassphraseKey(file, a) } catch (e) { fail(e.message) }
    console.log(`[ok] a new network key from your passphrase; ${file} (mode 600) holds its salt and public key, nothing secret`)
    console.log('Keep BOTH: the passphrase (in your head or a password manager) and a copy of this file (offline). Either alone is not enough; losing either means a new network.')
  } else if (opt('--passphrase')) {
    try { pub = readKdf(opt('--passphrase')).pub } catch (e) { fail(e.message) }
  } else fail(`network key needs --yubikey, --file <keyfile> or --passphrase[-new] <root.kdf>\n${USAGE}`)
  console.log(`rootPub      ${pub}`)
  console.log(`fingerprint  ${await rootFingerprint(pub)}`)
  process.exit(0)
}

// ---- network sign ----------------------------------------------------------
if (cmd === 'sign') {
  const src = positional[0]
  if (!src) fail(`network sign needs a profile.json\n${USAGE}`)
  const signer = signerFrom(opt, has)
  if (!signer) fail('network sign needs --sign-yubikey, --sign <keyfile> or --sign-passphrase <root.kdf>')
  const missing = signer.preflight()
  if (missing.length) fail(`cannot sign with the ${signer.what}: missing ${missing.join('; ')}`)
  let draft
  try { draft = JSON.parse(readFileSync(src, 'utf8')) } catch (e) { fail(`${src}: ${e.message}`) }
  if (draft['onchato-network'] === 1) fail(`${src} is already a signed envelope - sign the profile it was made from`)
  if (opt('--nodes')) {
    const nl = JSON.parse(readFileSync(opt('--nodes'), 'utf8'))
    draft.nodes = Array.isArray(nl) ? nl : nl.nodes
  }
  // --root-pub: when the token will not hand its public key over; a wrong one fails the check after signing.
  const rootPub = opt('--root-pub') ?? signer.pub()
  if (draft.rootPub && draft.rootPub !== rootPub) fail(`the profile names rootPub ${draft.rootPub}, the ${signer.what} holds ${rootPub} - a different key would be refused by every device that already pinned this network`)
  const out = opt('--out', 'network.json')
  let seq = opt('--seq') !== undefined ? Number(opt('--seq')) : undefined
  let before
  if (existsSync(out)) {
    const r = openEnvelope(readFileSync(out, 'utf8'), Date.now(), undefined, { allowExpired: true })
    if (r.ok) before = r.profile
  }
  if (before && before.networkId === draft.networkId) {
    if (before.rootPub !== rootPub) fail(`${out} is this network under ANOTHER root key (${await rootFingerprint(before.rootPub)}) - devices that joined will refuse the new one`)
    if (seq === undefined) seq = before.seq + 1
    else if (seq <= before.seq) fail(`--seq ${seq} is not above ${out}'s ${before.seq} - devices holding that one would refuse it as a rollback`)
  }
  const now = Date.now()
  const days = Number(opt('--days', '120'))
  if (!(days > 0 && days <= 400)) fail('--days must be 1-400')
  // Field order is the order of the profile people read; the signature covers these exact bytes.
  const profile = {
    v: 1, networkId: draft.networkId, operator: draft.operator, rootPub,
    seq: seq ?? draft.seq ?? 1, made: now, expires: now + days * DAY,
    nodes: draft.nodes, stores: draft.stores, app: draft.app, legacyApp: draft.legacyApp ?? [],
    profileUrls: draft.profileUrls, feedback: draft.feedback ?? null, home: draft.home, policy: draft.policy ?? {},
  }
  try { parseOperatorProfile(profile) } catch (e) { fail(`the profile would be refused: ${e.message}`) }
  const bytes = new TextEncoder().encode(JSON.stringify(profile))
  let sig
  try { await signer.unlock?.(); sig = signer.sign(bytes) } catch (e) { fail(e.message) }
  const text = JSON.stringify({ 'onchato-network': 1, profile: Buffer.from(bytes).toString('base64'), sig }) + '\n'
  const back = openEnvelope(text, Date.now())
  if (!back.ok) fail(`the signed file does not open (${back.why}${back.detail ? `: ${back.detail}` : ''}) - nothing written`)
  writeFileSync(out, text)
  console.log(`[ok] ${out} signed with the ${signer.what} (${text.length} bytes)`)
  await describe(back.profile)
  console.log(`next: upload ${out} to every profileUrl (byte for byte), then \`onchato-ops network link <its URL> ${out}\` for the QR code`)
  process.exit(0)
}

// ---- network link ----------------------------------------------------------
if (cmd === 'link') {
  const [url, file] = positional
  if (!url || !file) fail(`network link needs the URL it is served at and the file\n${USAGE}`)
  const bytes = readFileSync(file)
  const r = openOrFail(bytes.toString('utf8'), file)
  const link = await pointerFor(url, new Uint8Array(bytes))
  if (!parseNetworkPointer(link)) fail(`${url} is not a URL an app accepts (https, no credentials)`)
  if (!r.profile.profileUrls.includes(url.split('#')[0])) console.log(`WARNING: ${url} is not among the profile's profileUrls - fine for joining, but refreshes go to ${r.profile.profileUrls.join(', ')}`)
  console.log(link)
  try { qrMatrix(link) } catch { fail(`the link is ${link.length} bytes - too long for a QR code; use a shorter URL`) }
  console.log(qrForTerminal(link))
  if (opt('--svg')) { writeFileSync(opt('--svg'), qrSvg(link, { size: 512 })); console.log(`[ok] QR code in ${opt('--svg')}`) }
  if (opt('--png')) { writeFileSync(opt('--png'), qrPng(link)); console.log(`[ok] QR code in ${opt('--png')}`) }
  console.log('The link names the file\'s exact bytes: re-signing changes it, so print a new code after every upload.')
  process.exit(0)
}

// ---- network check ---------------------------------------------------------
if (cmd === 'check') {
  const what = positional[0]
  if (!what) fail(`network check needs a file or a link\n${USAGE}`)
  let text
  const ptr = parseNetworkPointer(what)
  if (ptr) {
    const got = await fetchPointed(ptr)
    if (!got.ok) fail(got.why === 'cid' ? `${ptr.url} serves a file other than the one the link names (re-signed since? print a new link)` : `${ptr.url} could not be fetched`)
    console.log(`[ok] ${ptr.url} serves exactly the file the link names`)
    text = got.text
  } else {
    try { text = readFileSync(what, 'utf8') } catch (e) { fail(`${what}: ${e.message}`) }
  }
  const r = openOrFail(text, what)
  const expired = Date.now() > r.profile.expires
  console.log(`[${expired ? 'fail' : 'ok'}] signature good${expired ? ', but EXPIRED - apps refuse it' : ''}`)
  if (opt('--root-pub') && opt('--root-pub') !== r.profile.rootPub) fail(`signed by ${r.profile.rootPub}, not the expected ${opt('--root-pub')}`)
  await describe(r.profile)
  let bad = expired
  if (ptr || has('--online')) {
    for (const u of r.profile.profileUrls) {
      try {
        const res = await fetch(u, { cache: 'no-store', headers: { Origin: r.profile.app.origin } })
        const cors = res.headers.get('access-control-allow-origin')
        const o = res.ok ? openEnvelope(await res.text(), Date.now(), undefined, { allowExpired: true }) : null
        const seq = o?.ok ? o.profile.seq : null
        const corsOk = cors === '*' || cors === r.profile.app.origin
        const fine = res.ok && o?.ok && o.profile.rootPub === r.profile.rootPub && corsOk
        if (!fine) bad = true
        console.log(`  [${fine ? 'ok' : 'fail'}] ${u}: HTTP ${res.status}${o ? (o.ok ? `, seq ${seq}${seq < r.profile.seq ? ' (OLDER than this one)' : ''}` : `, refused (${o.why})`) : ''}, CORS ${cors ?? 'none - the app cannot read it'}`)
      } catch (e) { bad = true; console.log(`  [fail] ${u}: ${e.message}`) }
    }
  }
  process.exit(bad ? 1 : 0)
}

fail(`unknown network command ${cmd ?? ''}\n${USAGE}`)
