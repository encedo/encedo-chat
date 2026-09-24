/**
 * light.ts — the light transport: no GossipSub in the client, one relay, the
 * `/onchato/pick/1` stream instead. Wears the shape the engine already knows
 * (`net/mqtt-node.ts` set the precedent): subscribe / unsubscribe / publish, a
 * `message` event, `getSubscribers`, `peerId`, `getConnections`, `stop`, and
 * `dial` -- so `room.ts`, `core.ts`, presence, groups, EH-2 and every test
 * stay untouched, and choosing it is one line in `startSession`.
 *
 * Stage 2, phase C of the light-client plan (~/.claude memory
 * light-client-plan; the relay half is relay/pick.mjs). What a light client
 * stops doing: forming a mesh, sending and receiving subscription lists,
 * gossip and heartbeats -- everything GossipSub does among equals, which a
 * leaf that talks to one relay never needed. What it still is: a libp2p peer
 * (WebSocket, Noise, yamux), because the relay's front door is one; going
 * lower is a separate decision.
 *
 * ## Mapping
 *
 *   subscribe(t)       -> PICK t     ... PICKED t  => getSubscribers(t) = [relay]
 *                                    ... REFUSED t => stays [], onRefused(t)
 *   unsubscribe(t)     -> DROP t
 *   publish(t, bytes)  -> PUSH t bytes ... ACK t n => { recipients: n slots }
 *   DELIVER from t bytes -> 'message' { topic: t, data: bytes, from }
 *
 * `from` on a delivery is the GossipSub publisher the relay saw -- for a
 * pushed frame that is the relay itself. That is fine since 0.6.22: the
 * sender rides inside every frame (lib/origin.ts) and no receiver reads the
 * transport's word about it any more. This transport does not open the
 * envelope either.
 *
 * ## Two things GossipSub gave for free that are done by hand here
 *
 * The room announces only once the relay is in its topic (`getSubscribers`
 * non-empty); with GossipSub that comes from the relay's subscription
 * announcement, here from PICKED. And the room's isolation detector reads how
 * many peers a publish reached; here that is the ACK's count, correlated to
 * the publish in order per topic (the stream is ordered, the relay answers in
 * order). No answer within ACK_TIMEOUT_MS is reported as `recipients: null` --
 * "no evidence", which the room already treats as such.
 *
 * ## Reconnect
 *
 * A pick lives on a stream, a stream on a connection. When the connection
 * goes, so does everything picked, and core re-dials through `dial()` exactly
 * as it does for GossipSub: this transport opens a fresh stream on that dial
 * and re-PICKs every topic it still holds. Until PICKED comes back for a topic
 * its `getSubscribers` is empty again, which is the truth.
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import { pushable } from 'it-pushable'
import { PROTOCOL, T, encodePick, encodeDrop, encodePush, decodeFrame } from '../../relay/pick.mjs'

export const ACK_TIMEOUT_MS = 5_000

const wsFilter = (addrs: any[]) => addrs.filter((ma) => /\/(wss?)(\/|$)/.test(ma.toString()))

/** What the adapter needs from a stream; the libp2p glue below provides it, a test can fake it. */
export interface PickStream {
  send(bytes: Uint8Array): void
  close(): void
}
export interface LightOpts {
  onLog?: (msg: string, level?: 'info' | 'debug') => void
  /** The relay said no to a topic. The first non-silent refusal in the system: tell the user. */
  onRefused?: (topic: string) => void
  /** Injected in tests: opens a pick stream to `relayId` and feeds frames back through `onFrame`. */
  openStream?: (relayId: string, onFrame: (f: any) => void, onClose: () => void) => Promise<PickStream>
  ackTimeoutMs?: number
}

/**
 * The transport-agnostic half: the pick/push state machine over any stream.
 * Exported so it can be tested without libp2p; `createLightPeer` wires it to
 * a real node.
 */
export function pickAdapter(self: string, opts: LightOpts) {
  const log = opts.onLog ?? (() => {})
  const ackTimeout = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS
  const listeners: Array<(evt: any) => void> = []
  const held = new Set<string>()          // what the engine asked for
  const picked = new Set<string>()        // what the relay confirmed
  const waitingAck = new Map<string, Array<(n: number | null) => void>>()
  let stream: PickStream | null = null
  let relayId: string | null = null

  const onFrame = (f: any) => {
    if (!f) return
    if (f.type === T.DELIVER) {
      const evt = { detail: { topic: f.topic, data: f.data, from: { toString: () => f.from } } }
      for (const h of [...listeners]) { try { h(evt) } catch (e: any) { log(`light: listener threw: ${e?.message ?? e}`) } }
    } else if (f.type === T.PICKED) {
      if (held.has(f.topic)) picked.add(f.topic)
    } else if (f.type === T.REFUSED) {
      picked.delete(f.topic)
      log(`light: relay REFUSED topic ${f.topic.slice(0, 12)}...`)
      opts.onRefused?.(f.topic)
    } else if (f.type === T.ACK) {
      const q = waitingAck.get(f.topic)
      const resolve = q?.shift()
      if (q && q.length === 0) waitingAck.delete(f.topic)
      resolve?.(f.recipients)
    }
  }
  const onClose = () => {
    stream = null
    picked.clear()
    for (const [, q] of waitingAck) for (const r of q) r(null)
    waitingAck.clear()
  }

  return {
    /** A new connection is up: open the stream and re-pick everything held. */
    async attach(toRelayId: string, open: (relayId: string, onFrame: (f: any) => void, onClose: () => void) => Promise<PickStream>) {
      try { stream?.close() } catch {}
      stream = null; picked.clear(); relayId = toRelayId
      const s = await open(toRelayId, onFrame, onClose)
      stream = s
      for (const t of held) s.send(encodePick(t))
      log(`light: pick stream open to ${toRelayId.slice(0, 12)}..., re-picked ${held.size} topic(s)`)
    },
    detach() { try { stream?.close() } catch {}; onClose() },
    connected: () => stream !== null,
    pubsub: {
      addEventListener: (_e: string, h: (evt: any) => void) => { listeners.push(h) },
      removeEventListener: (_e: string, h: (evt: any) => void) => { const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1) },
      subscribe: (topic: string) => {
        if (held.has(topic)) return
        held.add(topic)
        stream?.send(encodePick(topic))
      },
      unsubscribe: (topic: string) => {
        if (!held.delete(topic)) return
        picked.delete(topic)
        stream?.send(encodeDrop(topic))
      },
      /** The relay, once it has said PICKED; nobody before, nobody after a refusal. */
      getSubscribers: (topic: string) => (picked.has(topic) && relayId ? [{ toString: () => relayId! }] : []),
      publish: async (topic: string, data: Uint8Array) => {
        if (!stream) throw new Error('light: no pick stream (not connected)')
        const reach = await new Promise<number | null>((resolve) => {
          const q = waitingAck.get(topic) ?? []
          waitingAck.set(topic, q)
          let done = false
          const settle = (n: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve(n) }
          const timer = setTimeout(() => { const i = q.indexOf(settle); if (i >= 0) q.splice(i, 1); settle(null) }, ackTimeout)
          ;(timer as any).unref?.()
          q.push(settle)
          stream!.send(encodePush(topic, data))
        })
        // The room reads `recipients.length`; null keeps "no evidence" distinct from zero.
        return { recipients: reach === null ? null : new Array(reach).fill(0) } as any
      },
    },
  }
}

/** A libp2p node WITHOUT GossipSub, wearing the engine's node shape via the pick adapter. */
export async function createLightPeer(opts: LightOpts = {}) {
  const log = opts.onLog ?? (() => {})
  const node: any = await createLibp2p({
    transports: [webSockets({ filter: wsFilter })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify() },
  })
  await node.start()
  const self = node.peerId.toString()
  const adapter = pickAdapter(self, opts)

  const openStream = opts.openStream ?? (async (relayId: string, onFrame: (f: any) => void, onClose: () => void): Promise<PickStream> => {
    const conn = node.getConnections().find((c: any) => c.remotePeer.toString() === relayId)
    if (!conn) throw new Error('light: no connection to the relay')
    const stream = await conn.newStream(PROTOCOL)
    const out = pushable<Uint8Array>()
    let closed = false
    const bye = () => { if (closed) return; closed = true; try { out.end() } catch {}; onClose() }
    void pipe(out, (s) => lp.encode(s), stream.sink).catch(() => {}).finally(bye)
    void pipe(stream.source, (s) => lp.decode(s), async (src) => {
      for await (const chunk of src) onFrame(decodeFrame(chunk.subarray()))
    }).catch(() => {}).finally(bye)
    return { send: (b) => { if (!closed) out.push(b) }, close: () => { bye(); try { stream.abort(new Error('closed')) } catch {} } }
  })

  // The connection dropping takes the stream with it; core watches this same
  // event to re-dial, and the adapter forgets its picks so getSubscribers
  // tells the truth meanwhile.
  node.addEventListener('connection:close', () => { if (node.getConnections().length === 0) adapter.detach() })

  return {
    peerId: node.peerId,
    getConnections: () => node.getConnections(),
    addEventListener: (e: string, h: any) => node.addEventListener(e, h),
    removeEventListener: (e: string, h: any) => node.removeEventListener(e, h),
    async stop() { adapter.detach(); await node.stop() },
    /** `dial(node, addr, opts)` in net/peer.ts lands here: connect, then open the pick stream. */
    async dial(addr: any, dialOpts?: any) {
      const ma = typeof addr === 'string' ? multiaddr(addr) : addr
      const conn = await node.dial(ma, dialOpts)
      const relayId = conn.remotePeer.toString()
      await adapter.attach(relayId, openStream)
      log(`light: connected to ${relayId.slice(0, 12)}... without GossipSub`)
      return conn
    },
    services: { pubsub: adapter.pubsub },
    /** For diagnostics. */
    light: true,
  }
}
