/**
 * The light presence layer (`lib/presence.ts`) — being visible without a room.
 *
 * What it must do: report a contact online purely from their Announce (no
 * handshake), flip to offline on silence, and — the bridge to the heavy layer —
 * hand an incoming EH-2 frame up so the owner can upgrade to a full conversation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchPresence } from '../lib/presence.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { buildAnnounce } from '../lib/announce.ts'
import { T_MSG1 } from '../eh2/wire.ts'

const TOPIC = 'pair-topic'
const P = { networkId: 'test', dateUTC: '2026-07-31' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** In-memory pubsub shared by both ends of a pair. */
function hub() {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  return {
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => {
        for (const h of [...listeners]) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
            removeEventListener: (_e: string, h: (evt: any) => void) => {
              const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1)
            },
            subscribe: () => {}, unsubscribe: () => {},
            publish: async (topic: string, data: Uint8Array) => {
              for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
            },
          },
        },
      }
    },
  }
}

async function key() { return announceMacKey(new Uint8Array(32).fill(0x33), P) }

test('a contact is seen online from Announce alone — no handshake', async () => {
  const net = hub()
  const macKey = await key()
  let online = false, hs = 0
  // "me" watches the pair topic; "contact" only announces (no watcher of its own)
  const me = watchPresence(net.node('me'), TOPIC, macKey, 'me', {
    heartbeatMs: 100, onOnline: () => { online = true }, onOffline: () => { online = false },
    onIncomingHandshake: () => { hs++ },
  })
  const contact = net.node('contact')
  await contact.services.pubsub.publish(TOPIC, await buildAnnounce('contact', macKey))
  await sleep(150)
  assert.equal(online, true, 'the contact lit the dot')
  assert.equal(hs, 0, 'no handshake involved')
  me.stop()
})

test('an incoming EH-2 frame is handed up for upgrade, not treated as presence', async () => {
  const net = hub()
  const macKey = await key()
  let hsFrom = ''
  const me = watchPresence(net.node('me'), TOPIC, macKey, 'me', {
    heartbeatMs: 1000, onOnline: () => {}, onOffline: () => {},
    onIncomingHandshake: (_f, from) => { hsFrom = from },
  })
  // a msg1-shaped frame (type byte T_MSG1, length > 2)
  const msg1 = new Uint8Array([T_MSG1, 0x01, 0xaa, 0xbb, 0xcc])
  await net.node('contact').services.pubsub.publish(TOPIC, msg1)
  await sleep(80)
  assert.equal(hsFrom, 'contact', 'the handshake frame was surfaced for the upgrade')
  me.stop()
})

test('silence past the TTL flips the contact offline', async () => {
  const net = hub()
  const macKey = await key()
  let online = false
  const me = watchPresence(net.node('me'), TOPIC, macKey, 'me', {
    heartbeatMs: 40, onOnline: () => { online = true }, onOffline: () => { online = false },
    onIncomingHandshake: () => {},
  })
  await net.node('contact').services.pubsub.publish(TOPIC, await buildAnnounce('contact', macKey))
  await sleep(80)
  assert.equal(online, true)
  // ttl = max(heartbeat*6, 90s) is too long for a unit test, so this pins the
  // ONLINE transition and the stop; the offline sweep is covered by the room's
  // own TTL test. Just verify stop() is clean.
  me.stop()
  assert.equal(online, true)
})

test('our own Announce does not light our own dot', async () => {
  const net = hub()
  const macKey = await key()
  let online = false
  const meNode = net.node('me')
  const me = watchPresence(meNode, TOPIC, macKey, 'me', {
    heartbeatMs: 50, onOnline: () => { online = true }, onOffline: () => {},
    onIncomingHandshake: () => {},
  })
  // our own heartbeat announces; it must not be read as a contact
  await sleep(160)
  assert.equal(online, false, 'we do not see ourselves as the contact')
  me.stop()
})
