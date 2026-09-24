/**
 * The room and the presence watch read the sender from the frame when it is
 * there (`lib/origin.ts`). This is the stage-2 picture: every frame arrives
 * wrapped, and the TRANSPORT says the same sender for everybody -- a relay
 * publishing on the clients' behalf. If the handlers still keyed on the
 * transport, both peers would see `from = relay`, the sessions would collapse
 * into one and the handshake would never complete.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinChat } from '../lib/room.ts'
import { watchPresence } from '../lib/presence.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { buildAnnounce } from '../lib/announce.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { wrap } from '../lib/origin.ts'

const TOPIC = 'pair-topic'
const P = { networkId: 'test', dateUTC: '2026-09-24' }
const RELAY = 'relay-peer'

/**
 * In-memory pubsub that behaves like a relay pushing for its clients: every
 * published frame is wrapped with the PUBLISHER's id, and delivered with the
 * relay as the transport sender. A peer for which `raw` is true is an old
 * client on the same topic: it publishes bare frames through its own
 * GossipSub, so the transport names it truthfully.
 */
function relayHub(raw?: (id: string) => boolean) {
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
              const old = raw?.(id) ?? false
              const onWire = old ? data : wrap(id, data)
              for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, onWire, old ? id : RELAY)
            },
          },
        },
      }
    },
    /** A frame that reaches the topic from nowhere in particular. */
    inject(topic: string, data: Uint8Array) { for (const [, deliver] of nodes) deliver(topic, data, RELAY) },
  }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for: ${cond}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function pair(net: ReturnType<typeof relayHub>) {
  const macKey = await announceMacKey(new Uint8Array(32).fill(0x5e), P)
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub, attemptTimeoutMs: 300 })
  const got: Array<{ from: string; body: string }> = []
  const A = joinChat(net.node('peer-a'), TOPIC, { macKey, eh2: eh2(ikA, ikB.pub) }, { firstAnnounceMs: 5 })
  const B = joinChat(net.node('peer-b'), TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
    firstAnnounceMs: 5,
    onMessage: (from, m) => got.push({ from, body: m.body }),
  })
  return { A, B, got, macKey }
}

test('two rooms complete EH-2 although the transport names the relay as every sender', async (t) => {
  const net = relayHub()
  const { A, B, got } = await pair(net)
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))
  assert.ok(!A.secured().includes(RELAY) && !B.secured().includes(RELAY), 'the relay is not a peer')

  A.sendText('przez koperte')
  await until(() => got.length === 1)
  assert.equal(got[0].body, 'przez koperte')
  assert.equal(got[0].from, 'peer-a', 'the message is attributed to the sender, not the relay')
})

test('a new client and an old one share a topic: wrapped and raw frames, one handshake', async (t) => {
  // A publishes through the relay (wrapped); B is an old build publishing raw
  // through its own GossipSub. This is the transition, and it has to work in
  // BOTH directions or the rollout is a flag day.
  const net = relayHub((id) => id === 'peer-b')
  const { A, B, got } = await pair(net)
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))
  A.sendText('nowy do starego')
  await until(() => got.length === 1)
  assert.equal(got[0].from, 'peer-a')
})

test('a broken envelope is dropped and the room carries on', async (t) => {
  const net = relayHub()
  const { A, B, got, macKey } = await pair(net)
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))

  // Tag, a length that overruns the frame, rubbish: no sender to attribute it
  // to, so it must be ignored -- not thrown, not counted against anybody.
  net.inject(TOPIC, Uint8Array.from([0xe1, 200, 1, 2, 3]))
  // A raw (untagged) Announce from a third party is the old form and must
  // still verify -- the transport sender is used for it.
  net.inject(TOPIC, await buildAnnounce('peer-c', macKey))

  A.sendText('dalej dziala')
  await until(() => got.length === 1)
  assert.equal(got[0].from, 'peer-a')
})

test('the presence watch lights up from a wrapped Announce relayed by somebody else', async (t) => {
  const net = relayHub()
  const macKey = await announceMacKey(new Uint8Array(32).fill(0x33), P)
  let online = false
  const me = watchPresence(net.node('me'), TOPIC, macKey, 'me', {
    heartbeatMs: 100, onOnline: () => { online = true }, onOffline: () => { online = false },
    onIncomingHandshake: () => {},
  })
  t.after(() => me.stop())
  const contact = net.node('contact')
  await contact.services.pubsub.publish(TOPIC, await buildAnnounce('contact', macKey))
  await until(() => online, 1000)

  // The negative: our OWN announce coming back wrapped with our id (a relay
  // echo) must be ignored the way a transport echo is.
  let flips = 0
  const me2 = watchPresence(net.node('me2'), 'other-topic', macKey, 'me2', {
    heartbeatMs: 100, onOnline: () => { flips++ }, onOffline: () => {},
    onIncomingHandshake: () => {},
  })
  t.after(() => me2.stop())
  net.inject('other-topic', wrap('me2', await buildAnnounce('me2', macKey)))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(flips, 0, 'a wrapped echo of our own announce is not a contact')
})
