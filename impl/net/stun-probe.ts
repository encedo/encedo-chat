/**
 * stun-probe.ts — ask a node's STUN server where we are coming from.
 *
 *   node net/stun-probe.ts bs1.onchato.com [--bad]
 *
 * The point of a check that is not the browser: when a direct attempt fails,
 * "is STUN answering" and "does WebRTC work here" are different questions, and
 * only the first one has a cheap answer. This sends the real Binding Request
 * (`infra/stun/stun.mjs` is what should reply) and prints the reflexive address.
 *
 * `--bad` additionally fires the datagrams the server MUST ignore — a TURN
 * Allocate, a wrong magic cookie, a truncated header, a length that lies. Any
 * answer to those is a finding, not a curiosity: every byte sent to an
 * unverified source address is amplification somebody can aim.
 */

import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'

const host = process.argv[2] ?? 'bs1.onchato.com'
const port = Number(process.env.PORT ?? 3478)
const alsoBad = process.argv.includes('--bad')
const COOKIE = 0x2112a442

function request(type = 0x0001, cookie = COOKIE, len = 0, extra = 0): Buffer {
  const b = Buffer.alloc(20 + extra)
  b.writeUInt16BE(type, 0); b.writeUInt16BE(len, 2); b.writeUInt32BE(cookie, 4)
  randomBytes(12).copy(b, 8)
  return b
}

/** The XOR-MAPPED-ADDRESS a Binding Success carries, or null. */
function reflexive(buf: Buffer, tid: Buffer): string | null {
  if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return null
  if (!buf.subarray(8, 20).equals(tid)) return null
  let at = 20
  while (at + 4 <= buf.length) {
    const type = buf.readUInt16BE(at)
    const len = buf.readUInt16BE(at + 2)
    const val = buf.subarray(at + 4, at + 4 + len)
    if (type === 0x0020 && len >= 8) {
      const family = val.readUInt8(1)
      const port = val.readUInt16BE(2) ^ (COOKIE >>> 16)
      if (family === 0x01) {
        const a = (val.readUInt32BE(4) ^ COOKIE) >>> 0
        return `${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}:${port}`
      }
      const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), tid])
      const parts: string[] = []
      for (let i = 0; i < 16; i += 2) parts.push(((val.readUInt8(4 + i) ^ mask[i]) * 256 + (val.readUInt8(5 + i) ^ mask[i + 1])).toString(16))
      return `[${parts.join(':')}]:${port}`
    }
    at += 4 + len + ((4 - (len % 4)) % 4)
  }
  return null
}

/** Send one datagram, wait `ms` for anything back. */
function ask(msg: Buffer, ms = 2500): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    const done = (v: Buffer | null) => { try { sock.close() } catch {} ; resolve(v) }
    const t = setTimeout(() => done(null), ms)
    sock.on('message', (d) => { clearTimeout(t); done(d) })
    sock.on('error', () => { clearTimeout(t); done(null) })
    sock.send(msg, port, host)
  })
}

const req = request()
const t0 = Date.now()
const answer = await ask(req)
if (!answer) { console.error(`✗ ${host}:${port} — no answer in 2.5 s (blocked, or the service is down)`); process.exit(1) }
const addr = reflexive(answer, req.subarray(8, 20))
if (!addr) { console.error(`✗ ${host}:${port} answered ${answer.length} B but not a Binding Success we can read`); process.exit(1) }
console.log(`✓ ${host}:${port} → you look like ${addr}  (${Date.now() - t0} ms, ${answer.length} B)`)

if (alsoBad) {
  const cases: Array<[string, Buffer]> = [
    ['TURN Allocate (we do not relay)', request(0x0003)],
    ['Binding Response, not a request', request(0x0101)],
    ['Binding Indication', request(0x0011)],
    ['wrong magic cookie', request(0x0001, 0xdeadbeef)],
    ['length longer than the datagram', request(0x0001, COOKIE, 8)],
    ['length not a whole word', request(0x0001, COOKIE, 2, 2)],
    ['truncated header', randomBytes(12)],
  ]
  let bad = 0
  for (const [what, msg] of cases) {
    const got = await ask(msg, 1200)
    if (got) { console.error(`  ✗ ANSWERED: ${what} (${got.length} B)`); bad++ }
    else console.log(`  ✓ ignored: ${what}`)
  }
  if (bad) { console.error(`\n${bad} datagram(s) that must be dropped got a reply — this is a reflector`); process.exit(1) }
  console.log('\n✓ everything that is not a Binding Request was dropped')
}
process.exit(0)
