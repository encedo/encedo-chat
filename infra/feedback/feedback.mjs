// onchato feedback sink — one POST, one line of JSONL, nothing else.
//
// The app's feedback form (web/src/feedback.ts) sends a small JSON document
// here; this appends it to a file and answers `{ok:true,id}`. That is the whole
// service, and the smallness is the point: it holds no account, no session, no
// database schema, and it never learns who wrote — nginx in front of it does
// the CORS, the per-IP rate limit and the TLS, and deliberately does NOT
// forward the client address (no X-Real-IP), so the only place an IP exists
// is the access log nginx keeps anyway.
//
//   node feedback.mjs                       # 127.0.0.1:9201, ./feedback.jsonl
//   FEEDBACK_FILE=/var/lib/onchato/feedback.jsonl node feedback.mjs
//
// Reading it back: `tail -f feedback.jsonl`, or
//   jq -r '"\(.ts) [\(.kind)] \(.app.version) \(.text)"' feedback.jsonl
//
// Zero dependencies, like the relay: `node feedback.mjs` and it runs.

import { createServer } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 9201)
const HOST = process.env.HOST ?? '127.0.0.1'
const FILE = process.env.FEEDBACK_FILE ?? new URL('./feedback.jsonl', import.meta.url).pathname

// The body cap is repeated in nginx (`client_max_body_size`); this one is for
// running the service bare, and for the day somebody loosens the other.
const MAX_BODY = 32 * 1024
const KINDS = new Set(['bug', 'idea', 'question', 'hem'])

// What a record may carry, and how long each part may be. Anything not listed
// is dropped rather than stored — a client that starts sending more does not
// get to widen the file's shape by itself.
const LIMITS = { text: 4000, contact: 200, lang: 8, diag: 8000 }
const APP_FIELDS = { version: 32, commit: 16, shell: 16, update: 16, ua: 400, screen: 16 }

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** `null` when the document is not a feedback record at all. */
function shape(body) {
  let j
  try { j = JSON.parse(body) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const text = str(j.text, LIMITS.text)?.trim()
  if (!text) return null
  const kind = KINDS.has(j.kind) ? j.kind : 'question'
  const app = {}
  if (j.app && typeof j.app === 'object') {
    for (const [k, max] of Object.entries(APP_FIELDS)) {
      const v = str(j.app[k], max); if (v) app[k] = v
    }
  }
  const rec = { kind, text, app }
  const contact = str(j.contact, LIMITS.contact)?.trim(); if (contact) rec.contact = contact
  const lang = str(j.lang, LIMITS.lang); if (lang) rec.lang = lang
  const diag = str(j.diag, LIMITS.diag); if (diag) rec.diag = diag
  return rec
}

// Appends are serialised through one promise chain: two records arriving in
// the same tick must not interleave their bytes in the file.
let queue = Promise.resolve()
const append = (line) => (queue = queue.then(() => appendFile(FILE, line + '\n', 'utf8')))

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0
  req.on('data', (c) => {
    size += c.length
    // Stop reading and let the handler answer 413; destroying the socket here
    // gave the client no response at all, just a reset.
    if (size > MAX_BODY) { req.pause(); reject(new Error('too large')); return }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const send = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Harmless behind nginx (which answers CORS itself) and needed when the
    // service is hit bare from a dev page.
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    })
    res.end(); return
  }
  if (req.method !== 'POST' || req.url !== '/feedback') { send(res, 404, { ok: false }); return }
  let body
  try { body = await readBody(req) } catch {
    res.setHeader('connection', 'close') // the rest of the upload is not wanted
    send(res, 413, { ok: false, error: 'too large' }); req.destroy(); return
  }
  const rec = shape(body)
  if (!rec) { send(res, 400, { ok: false, error: 'not a feedback record' }); return }
  const id = randomBytes(6).toString('hex')
  const line = JSON.stringify({ id, ts: new Date().toISOString(), ...rec })
  try { await append(line) } catch (e) {
    console.error(`[fail] append failed: ${e?.message ?? e}`)
    send(res, 500, { ok: false, error: 'not stored' }); return
  }
  console.log(`[ok] ${id} [${rec.kind}] ${rec.app.version ?? '?'} ${rec.text.length} chars${rec.contact ? ' +contact' : ''}`)
  send(res, 200, { ok: true, id })
})

server.listen(PORT, HOST, () => {
  console.log(`onchato feedback on http://${HOST}:${PORT}/feedback -> ${FILE}`)
})
