// onchato STUN — one question, one answer, and nothing else on the wire.
//
// WebRTC needs exactly one thing from a STUN server: tell me the address you
// see this packet coming from, so ICE can offer it as a candidate. That is a
// Binding Request in, a Binding Success Response with XOR-MAPPED-ADDRESS out
// (RFC 5389 §15.2), and this file is that and no more.
//
//   node stun.mjs                 # 0.0.0.0:3478 and [::]:3478
//   PORT=3478 HOST=0.0.0.0 node stun.mjs
//
// ## Why ours and not a public one
//
// The default was `stun:stun.l.google.com:19302`, which handed Google the IP
// and the negotiation timing of every direct attempt — a third party outside
// the operator, in a product whose whole point is not needing one. Our own
// runs on the nodes clients already connect to, so the operator learns an
// address it necessarily has anyway (the client is holding a WSS connection to
// the same host) and nobody else learns anything.
//
// ## Why hand-written and not coturn
//
// The same argument as the MQTT client and the password meter: the SUBSET is
// the point. coturn is a TURN server that can also do STUN, and TURN relays
// media for whoever asks — one misread config line away from an open relay
// somebody else's traffic rides for free. There is no such line here, because
// there is no relaying code. What is left is ~40 lines of parsing that a
// person can read in a sitting, running under the same systemd shape as the
// feedback sink.
//
// ## What it deliberately does NOT do
//
// No TURN (decided: hard-NAT pairs fall back to the node), no TLS/DTLS (a
// Binding Response says what everyone on the path already saw — the source
// address of the packet), no RFC 5780 behaviour discovery (CHANGE-REQUEST is
// how a STUN server is turned into a reflector aimed at somebody else), no
// SOFTWARE attribute (a version string is a fingerprint, and it costs bytes in
// exactly the direction amplification cares about).
//
// Zero dependencies, like the relay and the feedback sink.

import { createSocket } from 'node:dgram'

const PORT = Number(process.env.PORT ?? 3478)
const HOST = process.env.HOST ?? '0.0.0.0'
const HOST6 = process.env.HOST6 ?? '::'
const QUIET = process.env.QUIET === '1'

const COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const XOR_MAPPED_ADDRESS = 0x0020
const HEADER = 20

/**
 * Is this a Binding Request we should answer? Returns the 12-byte transaction
 * id, or null.
 *
 * Everything that is not exactly that is dropped without a reply — including
 * other STUN methods and the indication/response classes. A server that
 * answers more than it must is a server somebody can point at a third party:
 * every byte we send to an address we have not verified is amplification, so
 * the reply is only ever ~32 bytes for a ~20 byte question, and only ever for
 * the one question that has a legitimate asker.
 */
export function bindingRequestId(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER) return null
  const type = buf.readUInt16BE(0)
  if (type !== BINDING_REQUEST) return null // class + method in one check
  if (buf.readUInt32BE(4) !== COOKIE) return null
  const len = buf.readUInt16BE(2)
  // The length counts the attributes only, must be a whole number of 4-byte
  // words, and must match what actually arrived. A mismatch is a malformed or
  // truncated datagram, and guessing at one is how parsers grow bugs.
  if (len % 4 !== 0 || HEADER + len !== buf.length) return null
  return buf.subarray(8, 20)
}

/**
 * The answer: XOR-MAPPED-ADDRESS, the address obfuscated with the magic cookie
 * (and, for IPv6, the transaction id) exactly as RFC 5389 §15.2 says.
 *
 * The XOR is not security — it exists because middleboxes used to rewrite
 * anything that looked like an IP address inside a payload, and a mangled
 * reflexive candidate is an ICE failure nobody can debug.
 */
export function bindingResponse(tid, address, port, family) {
  const v6 = family === 'IPv6'
  const value = Buffer.alloc(v6 ? 20 : 8)
  value.writeUInt8(0, 0)
  value.writeUInt8(v6 ? 0x02 : 0x01, 1)
  value.writeUInt16BE(port ^ (COOKIE >>> 16), 2)
  const raw = ipBytes(address, v6)
  if (!raw) return null
  const mask = v6 ? Buffer.concat([cookieBuf(), tid]) : cookieBuf()
  for (let i = 0; i < raw.length; i++) value.writeUInt8(raw[i] ^ mask[i], 4 + i)

  const out = Buffer.alloc(HEADER + 4 + value.length)
  out.writeUInt16BE(BINDING_SUCCESS, 0)
  out.writeUInt16BE(4 + value.length, 2)
  out.writeUInt32BE(COOKIE, 4)
  tid.copy(out, 8)
  out.writeUInt16BE(XOR_MAPPED_ADDRESS, 20)
  out.writeUInt16BE(value.length, 22)
  value.copy(out, 24)
  return out
}

const cookieBuf = () => { const b = Buffer.alloc(4); b.writeUInt32BE(COOKIE, 0); return b }

/** Address text -> bytes. `::ffff:1.2.3.4` is an IPv4 client on a dual-stack socket. */
export function ipBytes(address, v6) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (!v6 || mapped) {
    const dotted = mapped ? mapped[1] : address
    const parts = dotted.split('.')
    if (parts.length !== 4) return null
    const b = Buffer.alloc(4)
    for (let i = 0; i < 4; i++) {
      const n = Number(parts[i])
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
      b[i] = n
    }
    return b
  }
  // IPv6 text form, including the one `::` run.
  const [head, tail] = address.split('%')[0].split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  if (tail === undefined && h.length !== 8) return null
  if (h.length + t.length > 8) return null
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  const b = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i] || '0', 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
    b.writeUInt16BE(n, i * 2)
  }
  return b
}

/**
 * A token bucket per source address.
 *
 * An ICE gathering asks once or twice; a browser reloading a page a few more.
 * The limit is here because the source address of a UDP datagram is a claim,
 * not a fact: a spoofed one turns any responder into a small reflector aimed at
 * whoever was named. The ratio here is ~1.6 (32 bytes out for 20 in), which is
 * poor as amplifiers go, and the bucket keeps even that from being worth
 * anybody's time.
 */
export function limiter({ perSec = 20, burst = 40, max = 50_000, now = () => Date.now() } = {}) {
  const seen = new Map()
  return {
    allow(ip) {
      const t = now()
      let e = seen.get(ip)
      if (!e) {
        // Under a spoofed-source flood the table is the only thing that grows.
        // Dropping it whole is fine: the buckets it holds are a second of
        // history, and rebuilding them costs nothing.
        if (seen.size >= max) seen.clear()
        e = { tokens: burst, ts: t }
        seen.set(ip, e)
      }
      e.tokens = Math.min(burst, e.tokens + ((t - e.ts) / 1000) * perSec)
      e.ts = t
      if (e.tokens < 1) return false
      e.tokens -= 1
      return true
    },
    sweep(idleMs = 60_000) {
      const t = now()
      for (const [ip, e] of seen) if (t - e.ts > idleMs) seen.delete(ip)
      return seen.size
    },
    get size() { return seen.size },
  }
}

// ---- the server ------------------------------------------------------------

function serve() {
  const stats = { served: 0, ignored: 0, limited: 0 }
  const gate = limiter()

  const bind = (family, host) => {
    const sock = createSocket({ type: family, ipv6Only: family === 'udp6', reuseAddr: true })
    sock.on('message', (msg, rinfo) => {
      const tid = bindingRequestId(msg)
      if (!tid) { stats.ignored++; return }
      if (!gate.allow(rinfo.address)) { stats.limited++; return }
      const out = bindingResponse(tid, rinfo.address, rinfo.port, rinfo.family)
      if (!out) { stats.ignored++; return }
      sock.send(out, rinfo.port, rinfo.address, () => {})
      stats.served++
    })
    sock.on('error', (e) => {
      console.error(`[fail] ${family}: ${e.message}`)
      if (family === 'udp4') process.exit(1) // v4 is not optional; v6 is
      try { sock.close() } catch {}
    })
    sock.bind(PORT, host, () => console.log(`[ok] STUN ${family} ${host}:${PORT}`))
    return sock
  }

  console.log(`onchato STUN — Binding Request only, no TURN, no TLS`)
  bind('udp4', HOST)
  bind('udp6', HOST6)

  const t = setInterval(() => {
    gate.sweep()
    if (!QUIET) console.log(`served ${stats.served} | ignored ${stats.ignored} | rate-limited ${stats.limited} | sources ${gate.size}`)
  }, 300_000)
  t.unref?.()
}

// Importable for tests (the parser and the responder are pure); a server only
// when this file is what was run.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve()
