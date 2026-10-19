/**
 * enroll.mjs - a device joins a network that admits devices by list
 * (`policy.access: "allowlist"`, OPERATOR-NODE-PLAN.md, access tier B).
 *
 *   node enroll.mjs        (the node image's `enroll` service; env below)
 *
 * The device asks for a challenge, then sends its PeerId, the challenge, the
 * administrator's TOTP code (8 digits) and a signature over all of it by its
 * libp2p key - so the PeerId put on the list is one whose key the device holds.
 * On success the PeerId goes onto the list the relay follows (allowlist.mjs).
 * A second endpoint answers "am I on the list?", also signed, so nobody can ask
 * about somebody else's device.
 *
 * Guessing the code: one TOTP window either side is accepted (3 codes of 10^8),
 * a code that worked once does not work again, an address gets 5 wrong codes per
 * 10 minutes, and 20 wrong codes network-wide LOCK enrolment until the
 * administrator unlocks it (onchato-ops access unlock). Locked, the network can
 * be annoyed (no one enrols) but not entered.
 *
 * Env: ENROLL_PORT (9204), NETWORK_ID, ALLOW_PEERS (the list), ACCESS_DIR (seed,
 * lock, failure count; default the list's directory). Code is ASCII (repo rule).
 */
import { createServer } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPublicKey, verify as edVerify } from 'node:crypto'
import { parseAllowlist } from './allowlist.mjs'

export const DIGITS = 8
export const STEP_S = 30
export const NONCE_TTL_MS = 120_000
export const PER_IP_FAILURES = 5
export const PER_IP_WINDOW_MS = 10 * 60_000
export const LOCK_AFTER = 20

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const fromBase32 = (s) => {
  let bits = ''
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('not base32'); bits += v.toString(2).padStart(5, '0') }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)))
}
export const toBase32 = (buf) => {
  let bits = '', out = ''
  for (const x of buf) bits += x.toString(2).padStart(8, '0')
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

/** RFC 6238 TOTP (HMAC-SHA-1) for the counter `t`. */
export function totpAt(key, counter, digits = DIGITS) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(c).digest(); const o = h[19] & 15
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 10 ** digits).padStart(digits, '0')
}
/** The window (counter) a code belongs to, or null: this one and one either side. */
export function totpMatch(key, code, nowMs) {
  if (!/^\d{8}$/.test(code)) return null
  const now = Math.floor(nowMs / 1000 / STEP_S)
  for (const c of [now, now - 1, now + 1]) if (totpAt(key, c) === code) return c
  return null
}

/** What the device signs. Fixed text, so a signature for one purpose is no use for another. */
export const enrollMessage = (networkId, nonce, code) => new TextEncoder().encode(`onchato-enroll-v1\n${networkId}\n${nonce}\n${code}`)
export const statusMessage = (networkId, nonce) => new TextEncoder().encode(`onchato-status-v1\n${networkId}\n${nonce}`)

// ---- a PeerId's own key, without libp2p -------------------------------------------
// An Ed25519 PeerId (12D3KooW...) is base58btc of an identity multihash of the
// key's protobuf: 0x00 0x24 | 0x08 0x01 0x12 0x20 | 32 key bytes. Read here with
// no dependency, so this service needs nothing installed (and the app's tests can
// load it); a test holds it to @libp2p/peer-id.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(s) {
  let n = 0n
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error('not base58'); n = n * 58n + BigInt(v) }
  const out = []
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n }
  for (const c of s) { if (c !== '1') break; out.unshift(0) }
  return Buffer.from(out)
}
const ED_HEAD = Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20])
const SPKI_ED = Buffer.from('302a300506032b6570032100', 'hex')
/** The Ed25519 public key inside a PeerId, or null for anything else. */
export function ed25519OfPeerId(peerId) {
  try {
    const b = base58(peerId)
    return b.length === 38 && b.subarray(0, 6).equals(ED_HEAD) ? b.subarray(6) : null
  } catch { return null }
}

async function signedBy(peerId, msg, sigB64) {
  try {
    const raw = ed25519OfPeerId(peerId)
    if (!raw) return false
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED, raw]), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(msg), key, Buffer.from(sigB64, 'base64'))
  } catch { return false }
}

/**
 * The service's logic, without HTTP - what the tests drive. `now` and `rand`
 * are injectable; the files are real (a temp dir in tests).
 */
export function makeEnroll({ networkId, listFile, accessDir = dirname(listFile), now = () => Date.now(), rand = () => randomBytes(32).toString('base64url'), log = console.log }) {
  const seedFile = join(accessDir, 'totp.seed'), lockFile = join(accessDir, 'enroll.locked'), failFile = join(accessDir, 'enroll.failures')
  const nonces = new Map()   // nonce -> expiry
  const used = new Map()     // `${counter}:${code}` -> expiry
  const perIp = new Map()    // ip -> [failure times]
  const failures = () => { try { return Number(readFileSync(failFile, 'utf8')) || 0 } catch { return 0 } }
  const sweep = () => {
    const t = now()
    for (const [k, exp] of nonces) if (exp < t) nonces.delete(k)
    for (const [k, exp] of used) if (exp < t) used.delete(k)
  }
  const seed = () => { try { return fromBase32(readFileSync(seedFile, 'utf8').trim()) } catch { return null } }
  const listed = () => { try { return parseAllowlist(readFileSync(listFile, 'utf8')).ids } catch { return new Set() } }
  const takeNonce = (n) => { sweep(); if (!nonces.has(n)) return false; nonces.delete(n); return true }

  function fail(ip, why) {
    const t = now()
    const list = (perIp.get(ip) ?? []).filter((x) => t - x < PER_IP_WINDOW_MS); list.push(t); perIp.set(ip, list)
    const n = failures() + 1
    mkdirSync(accessDir, { recursive: true }); writeFileSync(failFile, String(n))
    log(`[enroll] wrong code from ${ip} (${why}; ${n} since the last unlock)`)
    if (n >= LOCK_AFTER && !existsSync(lockFile)) { writeFileSync(lockFile, new Date(t).toISOString() + '\n'); log(`[enroll] LOCKED after ${n} wrong codes - onchato-ops access unlock`) }
  }
  const ipBlocked = (ip) => (perIp.get(ip) ?? []).filter((x) => now() - x < PER_IP_WINDOW_MS).length >= PER_IP_FAILURES

  return {
    challenge() { sweep(); const n = rand(); nonces.set(n, now() + NONCE_TTL_MS); return { nonce: n, networkId } },

    /** { status, body } - status is the HTTP code. */
    async enroll({ peerId, nonce, code, sig, label }, ip = '?') {
      if (existsSync(lockFile)) return { status: 423, body: { error: 'locked', why: 'enrolment is locked after too many wrong codes; the administrator has to unlock it' } }
      if (ipBlocked(ip)) return { status: 429, body: { error: 'slow-down', why: 'too many wrong codes from this address; try again in 10 minutes' } }
      if (typeof peerId !== 'string' || typeof nonce !== 'string' || typeof code !== 'string' || typeof sig !== 'string') return { status: 400, body: { error: 'shape' } }
      if (!takeNonce(nonce)) return { status: 400, body: { error: 'challenge', why: 'the challenge is unknown or expired; ask for a new one' } }
      if (!await signedBy(peerId, enrollMessage(networkId, nonce, code), sig)) return { status: 400, body: { error: 'signature', why: 'not signed by the key of this PeerId' } }
      const key = seed()
      if (!key) return { status: 503, body: { error: 'not-set-up', why: 'this node has no enrolment code set up' } }
      const counter = totpMatch(key, code, now())
      if (counter === null) { fail(ip, 'no match'); return { status: 403, body: { error: 'code', why: 'wrong or expired code' } } }
      if (used.has(`${counter}:${code}`)) { fail(ip, 'used again'); return { status: 403, body: { error: 'code', why: 'this code was already used; wait for the next one' } } }
      used.set(`${counter}:${code}`, now() + 3 * STEP_S * 1000)
      if (!listed().has(peerId)) {
        let text = ''; try { text = readFileSync(listFile, 'utf8') } catch {}
        const clean = String(label ?? '').replace(/[^\p{L}\p{N} ._,()-]/gu, '').slice(0, 60)
        const line = `${peerId} ${clean ? clean + ' ' : ''}# enrolled ${new Date(now()).toISOString()}\n`
        mkdirSync(dirname(listFile), { recursive: true })
        const tmp = listFile + '.tmp'
        writeFileSync(tmp, (text && !text.endsWith('\n') ? text + '\n' : text) + line); renameSync(tmp, listFile)
        log(`[enroll] ok ${peerId.slice(-8)}${clean ? ` (${clean})` : ''}`)
      }
      return { status: 200, body: { ok: true, listed: true } }
    },

    async status({ peerId, nonce, sig }) {
      if (typeof peerId !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return { status: 400, body: { error: 'shape' } }
      if (!takeNonce(nonce)) return { status: 400, body: { error: 'challenge' } }
      if (!await signedBy(peerId, statusMessage(networkId, nonce), sig)) return { status: 400, body: { error: 'signature' } }
      return { status: 200, body: { listed: listed().has(peerId), locked: existsSync(lockFile) } }
    },
  }
}

// ---- the service ------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const listFile = process.env.ALLOW_PEERS
  const networkId = process.env.NETWORK_ID
  if (!listFile || !networkId) { console.error('enroll: ALLOW_PEERS and NETWORK_ID are needed'); process.exit(2) }
  const e = makeEnroll({ networkId, listFile, accessDir: process.env.ACCESS_DIR || dirname(listFile) })
  const PORT = Number(process.env.ENROLL_PORT ?? 9204)
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' })
    res.end(JSON.stringify(body))
  }
  createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end() }
    const path = (req.url ?? '').split('?')[0].replace(/^\/onchato\/enroll/, '')
    // nginx passes the real address; without it every caller would share one budget.
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?')
    if (req.method === 'GET' && (path === '/challenge' || path === '')) return send(res, 200, e.challenge())
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, { error: 'too-big' }) }
    let body; try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'json' }) }
    const r = path === '/status' ? await e.status(body) : path === '' || path === '/' ? await e.enroll(body, ip) : { status: 404, body: { error: 'path' } }
    send(res, r.status, r.body)
  }).listen(PORT, '127.0.0.1', () => console.log(`[ok] enroll on 127.0.0.1:${PORT} for ${networkId}, list ${listFile}`))
}
