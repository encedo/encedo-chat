/**
 * daemon.ts - the hub behind a local socket (CLI-PLAN.md stage 4).
 *
 *   $ONCHATO_SOCKET, else $XDG_RUNTIME_DIR/onchato.sock, else <ONCHATO_HOME>/onchato.sock
 *   mode 0600 - only this user can talk to it; the socket is the whole of its
 *   authentication, so it must never be group- or world-writable.
 *
 * The protocol is one JSON object per line, both ways:
 *   -> {"op":"send","to":"ewa","text":"...","wait":20000,"ttl":86400000,"key":"ssh"}
 *   <- {"ok":true,"status":"delivered","id":"...","ms":412,"to":"ewa"}   (or "queued" / "merged")
 *   -> {"op":"listen"}
 *   <- {"ok":true} then one event per line until the client hangs up
 *   -> {"op":"sendfile","to":"ewa","path":"/abs/raport.pdf"}   <- like send, plus "name"
 *   -> {"op":"get","id":"<message id or prefix>","dir":"/abs"} <- {"ok":true,"path":"/abs/raport.pdf"}
 *   -> {"op":"queue"}
 *   <- {"ok":true,"entries":[{"to":"ewa","age_s":40,"expires_in_s":86360,"key":"ssh","merged":2,"text":"..."}]}
 *   -> {"op":"status"}
 *   <- {"ok":true,"me":"ala","link":"online","online":["ewa"],"contacts":3}
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { onchatoHome } from './store.ts'
import type { Hub, HubEvent } from './hub.ts'
import type { Queue } from './queue.ts'

export function socketPath(): string {
  if (process.env.ONCHATO_SOCKET) return process.env.ONCHATO_SOCKET
  if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, 'onchato.sock')
  return join(onchatoHome(), 'onchato.sock')
}

/** Split a byte stream into JSON lines; a broken line is reported, not fatal. */
export function lineReader(onObj: (o: any) => void, onBad?: (line: string) => void) {
  let buf = ''
  return (chunk: string | Buffer) => {
    buf += String(chunk)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let o: any
      try { o = JSON.parse(line) } catch { onBad?.(line); continue }
      onObj(o)
    }
  }
}

export function serve(hub: Hub, path = socketPath(), log: (m: string) => void = () => {}, queue?: Queue): Promise<Server> {
  // A stale socket from a crashed run would make listen() fail; one that a LIVE
  // daemon holds must not be stolen - probe it first.
  return new Promise((resolve, reject) => {
    const start = () => {
      const srv = createServer((sock) => handle(hub, sock, log, queue))
      srv.on('error', reject)
      srv.listen(path, () => { chmodSync(path, 0o600); resolve(srv) })
    }
    if (!existsSync(path)) { start(); return }
    const probe = createConnection(path)
    probe.on('connect', () => { probe.destroy(); reject(new Error(`demon już działa (${path})`)) })
    probe.on('error', () => { try { unlinkSync(path) } catch {} ; start() })
  })
}

function handle(hub: Hub, sock: Socket, log: (m: string) => void, queue?: Queue) {
  const reply = (o: unknown) => { try { sock.write(JSON.stringify(o) + '\n') } catch {} }
  let unlisten: (() => void) | null = null
  sock.on('close', () => unlisten?.())
  sock.on('error', () => unlisten?.())
  // The client finished: close our side too, or the pair stays half-open.
  sock.on('end', () => sock.end())
  sock.on('data', lineReader(async (req) => {
    try {
      if (req.op === 'send') {
        if (typeof req.to !== 'string' || typeof req.text !== 'string' || !req.text) throw new Error('send potrzebuje "to" i "text"')
        const waitMs = typeof req.wait === 'number' ? req.wait : 20_000
        // With a queue (the daemon): offline -> waits on disk, keys coalesce.
        const r = queue
          ? await queue.submit(req.to, req.text, { waitMs, ttlMs: typeof req.ttl === 'number' ? req.ttl : undefined, key: typeof req.key === 'string' ? req.key : undefined })
          : { ok: true, ...(await hub.send(req.to, req.text, waitMs)) }
        log(`send -> ${r.to}: ${r.status}`)
        reply(r)
      } else if (req.op === 'listen') {
        reply({ ok: true })
        unlisten = hub.on((e: HubEvent) => reply(e))
      } else if (req.op === 'sendfile') {
        if (typeof req.to !== 'string' || typeof req.path !== 'string') throw new Error('sendfile potrzebuje "to" i "path"')
        const r = await hub.sendFile(req.to, req.path, typeof req.wait === 'number' ? req.wait : 20_000)
        log(`plik ${r.name} -> ${r.to}: ${r.status}`)
        reply({ ok: true, ...r })
      } else if (req.op === 'get') {
        if (typeof req.id !== 'string') throw new Error('get potrzebuje "id"')
        reply({ ok: true, path: await hub.getFile(req.id, typeof req.dir === 'string' ? req.dir : undefined) })
      } else if (req.op === 'queue') {
        reply({ ok: true, entries: queue?.list() ?? [] })
      } else if (req.op === 'status') {
        const ns = hub.session.netStatus()
        reply({ ok: true, me: hub.id.handle, link: ns.link, relay: ns.relay, contacts: hub.contactList.length, online: [...hub.online].map((p) => hub.nameOf(p)) })
      } else throw new Error(`nieznane op: ${req.op}`)
    } catch (e: any) { reply({ ok: false, error: e?.message ?? String(e) }) }
  }, () => reply({ ok: false, error: 'to nie jest JSON' })))
}

/** Connect to a running daemon; null when there is none. */
export function connectDaemon(path = socketPath()): Promise<Socket | null> {
  return new Promise((resolve) => {
    if (!existsSync(path)) { resolve(null); return }
    const s = createConnection(path)
    s.once('connect', () => resolve(s))
    s.once('error', () => resolve(null))
  })
}

/** One request, one reply. */
export function ask(sock: Socket, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const onData = lineReader((o) => { sock.off('data', onData); sock.off('error', reject); resolve(o) })
    sock.once('error', reject)
    sock.on('data', onData)
    sock.write(JSON.stringify(req) + '\n')
  })
}
