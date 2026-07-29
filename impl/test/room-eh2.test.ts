/**
 * EH-2 stage 6 — the room seam (docs/PROTOCOL.md §6–7 meeting §5).
 *
 * Offline test over a mock pubsub: two rooms on one topic, EH-2 enabled. What
 * it pins is the wiring, not the crypto (that is covered in eh2-*.test.ts):
 * the handshake runs by itself on discovery, content is sealed by the ratchet
 * (not the interim key), and a message typed before the handshake finishes
 * still arrives.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { interimSession } from '../lib/session.ts'
import { generateX25519 } from '../lib/x25519.ts'

const TOPIC = 'test-topic'
const P = { networkId: 'test', dateUTC: '2026-07-29' }

/** Minimal in-memory GossipSub: publish reaches every other node on the topic. */
function hub() {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  return {
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => {
        for (const h of listeners) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
            removeEventListener: () => {},
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

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Two rooms sharing a topic + Announce key, with EH-2 wired for both peers. */
async function rooms(opts: { collect: string[]; seen?: Uint8Array[] }) {
  const net = hub()
  const ss = new Uint8Array(32).fill(0x5e)
  const macKey = await announceMacKey(ss, P)
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  // ids chosen so 'peer-a' < 'peer-b' → A is the initiator
  const nodeA = net.node('peer-a')
  const nodeB = net.node('peer-b')
  const states: string[] = []
  const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub, onState: (p: string, s: string) => states.push(`${p}:${s}`) })

  const A = joinChat(nodeA, TOPIC, { macKey, eh2: eh2(ikA, ikB.pub) }, { firstAnnounceMs: 5 })
  const B = joinChat(nodeB, TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
    firstAnnounceMs: 5,
    onMessage: (_from, m) => opts.collect.push(m.body),
  })
  return { A, B, states }
}

test('the handshake runs on discovery and content rides the ratchet', async () => {
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got })

  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))
  assert.ok(states.some((s) => s === 'peer-b:established' || s === 'peer-a:established'))

  A.sendText('po ratchecie')
  await until(() => got.length === 1)
  assert.deepEqual(got, ['po ratchecie'])

  A.sendText('i druga')
  await until(() => got.length === 2)
  assert.deepEqual(got, ['po ratchecie', 'i druga'])
  A.stop(); B.stop()
})

test('content typed before the handshake completes is queued, not lost', async () => {
  const got: string[] = []
  const { A, B } = await rooms({ collect: got })
  A.sendText('wysłane zanim uzgodniliśmy klucz') // no session yet → queued
  assert.deepEqual(A.secured(), [])

  await until(() => got.length === 1, 8000)
  assert.deepEqual(got, ['wysłane zanim uzgodniliśmy klucz'])
  A.stop(); B.stop()
})

test('interim mode is untouched (no eh2 → static key, no handshake frames)', async () => {
  const net = hub()
  const ss = new Uint8Array(32).fill(0x11)
  const keys = { macKey: await announceMacKey(ss, P), session: await interimSession(ss, P) }
  const got: string[] = []
  const A = joinChat(net.node('peer-a'), TOPIC, keys, { firstAnnounceMs: 5 })
  const B = joinChat(net.node('peer-b'), TOPIC, keys, { firstAnnounceMs: 5, onMessage: (_f, m) => got.push(m.body) })

  A.sendText('stara droga')
  await until(() => got.length === 1)
  assert.deepEqual(got, ['stara droga'])
  assert.deepEqual(A.secured(), [], 'no EH-2 sessions in interim mode')
  A.stop(); B.stop()
})
