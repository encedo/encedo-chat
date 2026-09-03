/**
 * dump.mjs — DUMP=<dir>: write EVERYTHING the relay can observe to JSONL.
 *
 * Off by default, and off means off: relay.mjs calls `createDump(process.env.DUMP)`,
 * which returns null when the variable is unset or empty, and every call site is
 * `dump?.…` — no directory, no file, no listener, no wrapper, nothing on the hot
 * path. The only trace of this module on a node that does not set DUMP is the
 * import.
 *
 * Why it exists on a "zero log" node: debugging, and audit. Seven days of dump is
 * the COMPLETE observable surface of the relay — every address, peer id, topic
 * and every frame byte — so an auditor can check that nothing in it links a
 * person to a conversation or decodes to plaintext. That same completeness is
 * why it must NEVER run on production: the files ARE the metadata the design
 * promises not to keep. When on, the startup banner says so (🧾 DUMP ON), so its
 * absence from `journalctl -u onchato-relay` is the proof that production ran
 * clean.
 *
 * Two files per day in <dir> (dir 0700, files 0600), one JSON object per line,
 * every record `{ts, type, …}`, peer ids and multiaddrs written IN FULL:
 *
 *   events-YYYY-MM-DD.jsonl   control plane — start/stop, conn.open/conn.close,
 *                             sub/unsub, topic.add/topic.refuse/topic.evict,
 *                             reservation (circuit-relay-v2)
 *   payload-YYYY-MM-DD.jsonl  data plane — one record per GossipSub frame the
 *                             relay forwards: topic, from (publisher), via (the
 *                             peer that handed it to us), seq, msgId, size and
 *                             the bytes base64-encoded
 *
 * Circuit-relay HOP streams are the one blind spot: libp2p pipes those bytes
 * inside the library with no hook, so only the reservation and both connections
 * appear. The shipped client (impl/net/peer.ts) does not use circuits — all its
 * traffic is GossipSub, which lands in payload-*.jsonl whole.
 *
 * IP. Behind nginx every connection arrives from 127.0.0.1 (relay/README, peer
 * scoring). The libp2p WebSocket transport never surfaces the HTTP upgrade, so
 * with the dump on we wrap `http.createServer` and read `X-Real-IP` off the
 * upgrade request ourselves, keyed by nginx's loopback source port — the same
 * port libp2p reports in `connection.remoteAddr`, so the join is exact. nginx
 * has to send the header (infra/nginx/onchato.com, the /relay block); without
 * it `ip` is 127.0.0.1. Direct peers (the IPv6 inter-relay mesh) carry their
 * real address regardless.
 *
 * Writes are synchronous appends on a held fd: an audit wants every line on
 * disk when the process dies, and the relay's rate (heartbeats every ~15 s per
 * client) makes the cost irrelevant. Files roll over when the UTC date changes.
 */

import http from 'node:http'
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'

// The listener is dual-stack (Node binds `::` for 0.0.0.0), so an IPv4 client
// shows up as an IPv4-mapped IPv6 address — `::ffff:7f00:1` in multiaddr's
// hex spelling. Fold both spellings back to dotted IPv4 so `ip` reads as an
// address a human (or nginx's log) recognises; `addr` keeps the raw multiaddr.
const normIp = (host) => {
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)
  return dotted ? dotted[1] : host
}
const LOOPBACK = new Set(['127.0.0.1', '::1'])

// JSON.stringify chokes on BigInt (GossipSub's sequenceNumber) — write it as a string.
const json = (rec) => JSON.stringify(rec, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

export function createDump(dir) {
  if (!dir) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // nginx loopback source port → X-Real-IP, captured on the HTTP upgrade. it-ws
  // builds its server with a bare `http.createServer()`, so wrapping the module
  // function is the only way to see the request. Installed once, only when the
  // dump is on, before libp2p creates its listeners (relay.mjs orders it so).
  const ipByPort = new Map()
  const createServer = http.createServer
  http.createServer = function (...a) {
    const srv = createServer.apply(this, a)
    srv.on('upgrade', (req) => {
      const real = req.headers['x-real-ip']
      if (typeof real !== 'string' || !real) return
      const port = req.socket.remotePort
      ipByPort.set(port, real)
      req.socket.once('close', () => ipByPort.delete(port))
    })
    return srv
  }

  const files = { events: null, payload: null } // name → {day, fd}
  const write = (name, rec) => {
    const ts = new Date().toISOString()
    const day = ts.slice(0, 10)
    let f = files[name]
    if (!f || f.day !== day) {
      if (f) closeSync(f.fd)
      f = files[name] = { day, fd: openSync(join(dir, `${name}-${day}.jsonl`), 'a', 0o600) }
    }
    writeSync(f.fd, json({ ts, ...rec }) + '\n')
  }
  const close = () => {
    for (const name of Object.keys(files)) {
      if (files[name]) { closeSync(files[name].fd); files[name] = null }
    }
  }

  // The address a connection came from: X-Real-IP when nginx sent one for this
  // loopback port, otherwise whatever the multiaddr says (real for direct peers).
  const ipOf = (conn) => {
    try {
      const { host, port } = conn.remoteAddr.toOptions()
      const ip = normIp(host)
      return (LOOPBACK.has(ip) && ipByPort.get(port)) || ip
    } catch { return null }
  }
  // Full peer id → ip while at least one connection to it is open, so records
  // that only know a peer (sub, msg) still carry the address.
  const ipByPeer = new Map()

  const attach = (relay, { flags = [] } = {}) => {
    relay.addEventListener('connection:open', ({ detail: c }) => {
      const peer = c.remotePeer.toString()
      const ip = ipOf(c)
      ipByPeer.set(peer, ip)
      write('events', { type: 'conn.open', conn: c.id, peer, ip, addr: c.remoteAddr.toString(), dir: c.direction })
    })
    relay.addEventListener('connection:close', ({ detail: c }) => {
      const peer = c.remotePeer.toString()
      if (!relay.getConnections(c.remotePeer).some((o) => o.id !== c.id)) ipByPeer.delete(peer)
      write('events', { type: 'conn.close', conn: c.id, peer, ip: ipOf(c), addr: c.remoteAddr.toString(), dir: c.direction })
    })
    relay.services.pubsub.addEventListener('subscription-change', ({ detail }) => {
      const peer = detail.peerId.toString()
      for (const { topic, subscribe } of detail.subscriptions) {
        write('events', { type: subscribe ? 'sub' : 'unsub', peer, ip: ipByPeer.get(peer) ?? null, topic })
      }
    })
    // 'gossipsub:message' rather than 'message': same frame, plus WHO handed it
    // to us (propagationSource) and the message id the mesh deduplicates on.
    relay.services.pubsub.addEventListener('gossipsub:message', ({ detail }) => {
      const { msg, propagationSource, msgId } = detail
      const from = msg.from?.toString() ?? null
      const via = propagationSource.toString()
      write('payload', {
        type: 'msg', topic: msg.topic,
        from, ip: from ? ipByPeer.get(from) ?? null : null,
        via, viaIp: ipByPeer.get(via) ?? null,
        id: msgId, seq: msg.sequenceNumber ?? null,
        size: msg.data.length, data: Buffer.from(msg.data).toString('base64')
      })
    })
    relay.services.relay?.addEventListener('relay:reservation', ({ detail }) => {
      write('events', { type: 'reservation', peer: detail.addr.getPeerId(), addr: detail.addr.toString(), expiry: detail.expiry.toISOString() })
    })

    // --pass is the Ed25519 seed behind the PeerId — never on disk, even here.
    const safeFlags = flags.map((f, i) => (flags[i - 1] === '--pass' ? '<redacted>' : f))
    write('events', { type: 'start', pid: process.pid, node: process.version, peer: relay.peerId.toString(), flags: safeFlags })
    // A `stop` line closes the audit trail; only registered with the dump on, so
    // production shutdown stays Node's default.
    const stop = (signal) => { write('events', { type: 'stop', signal }); close(); process.exit(0) }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
  }

  return {
    dir,
    event: (type, rec) => write('events', { type, ...rec }),
    attach,
    close
  }
}
