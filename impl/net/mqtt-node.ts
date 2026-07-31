/**
 * mqtt-node.ts — the MQTT transport, wearing the shape the engine already knows.
 *
 * The engine talks to a libp2p node through a **very** small surface: subscribe,
 * unsubscribe, publish, a `message` event, `getSubscribers`, `peerId`,
 * `getConnections`, `stop`. That surface is not an accident of libp2p — it is
 * what our own test doubles have mocked all along, which makes it the de-facto
 * transport interface of this project. So the MQTT transport implements exactly
 * that, and `room.ts`, `core.ts`, the WebRTC plane, EH-2 and every test stay
 * untouched. Choosing a transport is a one-line decision in `startSession`.
 *
 * **Topic mapping.** GossipSub tells the room who sent a frame; MQTT does not,
 * so the sender goes in the topic instead of into the payload (which would mean
 * a wire change the crypto layer would have to know about):
 *
 *     publish   ec/<room-topic>/<our-client-id>
 *     subscribe ec/<room-topic>/+
 *
 * The room's own topics are already 32-byte derived secrets, so knowing one is
 * the authorisation to be in the room — the same property GossipSub gives us.
 * The broker must nonetheless be configured to refuse `#`, or one subscriber
 * could enumerate every room on it; see the MQTT section in README.md.
 *
 * What this transport does NOT do, deliberately: QoS above 0, retained messages,
 * persistent sessions. Those are the features that make a broker store traffic,
 * and storing traffic is exactly what this product does not do.
 */

import { mqttConnect, type MqttClient } from './mqtt.ts'
import { randomBytes } from '../lib/wc.ts'

export interface MqttPeerOpts {
  /** `wss://host/mqtt` in production (nginx terminates TLS), `mqtt://127.0.0.1:1883` locally. */
  url: string
  /** Namespace every topic, so one broker can host more than this app. */
  prefix?: string
  onLog?: (msg: string, level?: 'info' | 'debug') => void
}

/** A libp2p-node-shaped object backed by an MQTT broker. */
export async function createMqttPeer(opts: MqttPeerOpts) {
  const log = opts.onLog ?? (() => {})
  const prefix = opts.prefix ?? 'ec'
  // The client id is this session's identity on the wire — ephemeral, like the
  // libp2p PeerId it stands in for, and used the same way (lower id initiates).
  // base64 would put '/' and '+' in a topic segment; hex is boring and safe.
  const self = 'mq' + [...randomBytes(12)].map((b) => b.toString(16).padStart(2, '0')).join('')

  const listeners: Array<(evt: any) => void> = []
  const subscribed = new Set<string>()
  let client: MqttClient | null = null
  let stopped = false

  const wire = (topic: string, payload: Uint8Array) => {
    // ec/<room>/<sender>
    const parts = topic.split('/')
    const from = parts[parts.length - 1]
    const room = parts.slice(1, -1).join('/')
    if (from === self) return // emitSelf: false, as GossipSub is configured
    for (const h of [...listeners]) h({ detail: { topic: room, data: payload, from: { toString: () => from } } })
  }

  const connect = async () => {
    client = await mqttConnect({
      url: opts.url,
      clientId: self,
      onMessage: wire,
      onClose: (why) => { if (!stopped) log(`mqtt: ${why}`) },
      onLog: (m) => log(`mqtt: ${m}`, 'debug'),
    })
    for (const t of subscribed) await client.subscribe(`${prefix}/${t}/+`)
    log(`mqtt: connected to ${opts.url} as ${self}`)
  }
  await connect()

  return {
    peerId: { toString: () => self },
    /** The engine calls this to notice a dead transport; MQTT answers honestly. */
    getConnections: () => (client?.connected ? [{ close: async () => client?.close() }] : []),
    addEventListener: (_e: string, _h: any) => {}, // no 'connection:close' equivalent; the poll covers it
    async stop() {
      stopped = true
      try { client?.close() } catch {}
    },
    /** Re-dial. `dial()` in `net/peer.ts` maps onto this. */
    async reconnect() {
      try { client?.close() } catch {}
      await connect()
    },
    services: {
      pubsub: {
        addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
        removeEventListener: (_e: string, h: (evt: any) => void) => {
          const i = listeners.indexOf(h)
          if (i >= 0) listeners.splice(i, 1)
        },
        subscribe: (topic: string) => {
          subscribed.add(topic)
          void client?.subscribe(`${prefix}/${topic}/+`)
        },
        unsubscribe: (topic: string) => {
          subscribed.delete(topic)
          void client?.unsubscribe(`${prefix}/${topic}/+`)
        },
        /**
         * A broker does not tell a publisher who is listening. Returning null
         * (rather than 0) is the honest answer, and the room already treats "no
         * number" as "no evidence" — its isolation check only fires on a real
         * zero, so it simply does not fire on this transport. Liveness comes
         * from the MQTT keep-alive instead.
         */
        publish: async (topic: string, data: Uint8Array) => {
          client?.publish(`${prefix}/${topic}/${self}`, data)
          return { recipients: null as any }
        },
        /** No equivalent either — and none needed: a broker delivers from the
         *  moment we subscribe, with no mesh to graft first. */
        getSubscribers: () => [] as any[],
      },
    },
  }
}
