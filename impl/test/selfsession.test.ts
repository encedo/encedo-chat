/**
 * One active session per identity (docs/PROTOCOL.md §9.1) — `lib/selfsession.ts`.
 *
 * The self-topic carries only our own windows: nobody else can derive it or
 * forge an announce on it. What is under test is the rule that fires when there
 * is more than one — both stand down, deliberately, so that neither an accident
 * nor an intruder keeps a room by arriving second. What must NOT happen is a
 * lone window evicting itself, or a forged announce evicting anyone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchSelfSession } from '../lib/selfsession.ts'
import { announceMacKey } from '../lib/rendezvous.ts'

const TOPIC = 'self-topic'
const P = { networkId: 'test', dateUTC: '2026-07-30' }

/** In-memory pubsub, shared by every window in a test. */
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
              const i = listeners.indexOf(h)
              if (i >= 0) listeners.splice(i, 1)
            },
            subscribe: () => {},
            unsubscribe: () => {},
            publish: async (topic: string, data: Uint8Array) => {
              for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
            },
          },
        },
      }
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function key() { return announceMacKey(new Uint8Array(32).fill(0x21), P) }

/** A window of our identity, watching the self-topic. */
function window_(net: ReturnType<typeof hub>, id: string, macKey: CryptoKey, taken: string[]) {
  return watchSelfSession(net.node(id), TOPIC, macKey, id, {
    heartbeatMs: 100, graceMs: 200,
    onTakenOver: (by) => taken.push(`${id}<-${by}`),
  })
}

test('a second window closes BOTH sessions', async () => {
  // The product decision: neither duplicate keeps the room. Handing it to the
  // newcomer would mean a window that is not the user at all (a lifted token, a
  // machine left logged in) wins simply by arriving second.
  const net = hub()
  const macKey = await key()
  const taken: string[] = []

  const first = window_(net, 'peer-a', macKey, taken)
  await sleep(400) // let it settle in
  const second = window_(net, 'peer-b', macKey, taken)
  await sleep(700)

  assert.deepEqual(taken.sort(), ['peer-a<-peer-b', 'peer-b<-peer-a'], 'both windows stand down')
  first.stop(); second.stop()
})

test('two windows that start together also both close', async () => {
  // Simultaneous start: neither can tell who was first, and the answer is the
  // same — nobody continues on a guess.
  const net = hub()
  const macKey = await key()
  const taken: string[] = []

  const a = window_(net, 'peer-a', macKey, taken)
  const b = window_(net, 'peer-b', macKey, taken)
  await sleep(700)

  assert.deepEqual(taken.sort(), ['peer-a<-peer-b', 'peer-b<-peer-a'])
  a.stop(); b.stop()
})

test('a lone window is left alone', async () => {
  const net = hub()
  const taken: string[] = []
  const only = window_(net, 'peer-a', await key(), taken)
  await sleep(500)
  assert.deepEqual(taken, [])
  only.stop()
})

test('a stopped window stops announcing, so it cannot evict anyone', async () => {
  const net = hub()
  const macKey = await key()
  const taken: string[] = []
  const gone = window_(net, 'peer-z', macKey, taken)
  await sleep(300)
  gone.stop()

  const fresh = window_(net, 'peer-a', macKey, taken)
  await sleep(500)
  assert.deepEqual(taken, [], 'a window that has left is not a rival')
  fresh.stop()
})

test('an announce that does not verify is ignored', async () => {
  // The self-topic is only trustworthy because of the MAC: without it, anything
  // that reached the topic could evict a live session.
  const net = hub()
  const taken: string[] = []
  const mine = window_(net, 'peer-a', await key(), taken)
  await sleep(300)

  const stranger = net.node('peer-x')
  await stranger.services.pubsub.publish(TOPIC, new TextEncoder().encode(
    JSON.stringify({ v: 1, peer: 'peer-x', nonce: 'AAAA', ts: Date.now(), mac: 'AAAA' }),
  ))
  await sleep(300)

  assert.deepEqual(taken, [], 'a forged announce must not take a session over')
  mine.stop()
})
