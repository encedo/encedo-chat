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

/**
 * Minimal in-memory GossipSub: publish reaches every other node on the topic.
 * `drop` can swallow chosen frames — the real relay does exactly that while the
 * mesh forms, and a handshake that cannot survive it stalls forever.
 */
function hub(drop?: (data: Uint8Array, from: string) => boolean, duplicate?: (data: Uint8Array) => boolean) {
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
              if (drop?.(data, id)) return
              const times = duplicate?.(data) ? 2 : 1
              for (let n = 0; n < times; n++) {
                for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
              }
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
async function rooms(opts: { collect: string[]; drop?: (d: Uint8Array, from: string) => boolean; backA?: string[]; duplicate?: (d: Uint8Array) => boolean }) {
  const net = hub(opts.drop, opts.duplicate)
  const ss = new Uint8Array(32).fill(0x5e)
  const macKey = await announceMacKey(ss, P)
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  // ids chosen so 'peer-a' < 'peer-b' → A is the initiator
  const nodeA = net.node('peer-a')
  const nodeB = net.node('peer-b')
  const states: string[] = []
  const eh2 = (ik: any, peerPub: Uint8Array) => ({
    ik, peerIkPub: peerPub, attemptTimeoutMs: 300,
    onState: (p: string, s: string) => states.push(`${p}:${s}`),
  })

  const A = joinChat(nodeA, TOPIC, { macKey, eh2: eh2(ikA, ikB.pub) }, {
    firstAnnounceMs: 5,
    onMessage: (_from, m) => opts.backA?.push(m.body),
  })
  const B = joinChat(nodeB, TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
    firstAnnounceMs: 5,
    onMessage: (_from, m) => opts.collect.push(m.body),
  })
  /** A second window for B's identity — same keys, new PeerId (a page reload). */
  const rejoinB = (id: string, collect: string[]) =>
    joinChat(net.node(id), TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
      firstAnnounceMs: 5,
      onMessage: (_from, m) => collect.push(m.body),
    })
  return { A, B, states, rejoinB }
}

test('the handshake runs on discovery and content rides the ratchet', async (t) => {
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))
  assert.ok(states.some((s) => s === 'peer-b:established' || s === 'peer-a:established'))

  A.sendText('po ratchecie')
  await until(() => got.length === 1)
  assert.deepEqual(got, ['po ratchecie'])

  A.sendText('i druga')
  await until(() => got.length === 2)
  assert.deepEqual(got, ['po ratchecie', 'i druga'])
})

test('content typed before the handshake completes is queued, not lost', async (t) => {
  const got: string[] = []
  const { A, B } = await rooms({ collect: got })
  t.after(() => { A.stop(); B.stop() })
  A.sendText('wysłane zanim uzgodniliśmy klucz') // no session yet → queued
  assert.deepEqual(A.secured(), [])

  await until(() => got.length === 1, 8000)
  assert.deepEqual(got, ['wysłane zanim uzgodniliśmy klucz'])
})

test('a lost msg1 is retried until the handshake gets through', async (t) => {
  const got: string[] = []
  let swallowed = 0
  const { A, B } = await rooms({
    collect: got,
    drop: (d) => d[0] === 0x01 && ++swallowed <= 2, // eat the first two msg1s
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  assert.ok(swallowed >= 2, 'the drop actually fired')
  A.sendText('mimo zgubionych ramek')
  await until(() => got.length === 1)
})

test('a lost msg3 leaves the responder stuck — and it recovers on its own', async (t) => {
  // The nastiest case: the initiator completes and shows "established" while
  // the responder has nothing, so only the responder (the HIGHER id, which
  // normally never initiates) knows something is wrong.
  const got: string[] = []
  const back: string[] = []
  let seen = 0, dropped = 0
  const { A, B } = await rooms({
    collect: got, backA: back,
    drop: (d) => { // eat the FIRST msg3 only
      if (d[0] !== 0x03 || ++seen > 1) return false
      dropped++
      return true
    },
  })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  assert.equal(dropped, 1, 'exactly the first msg3 was swallowed')
  A.sendText('od A po odzyskaniu')
  B.sendText('od B po odzyskaniu')
  await until(() => got.length === 1 && back.length === 1, 5000)
  assert.deepEqual(got, ['od A po odzyskaniu'])
  assert.deepEqual(back, ['od B po odzyskaniu'])
})

test('a peer that reloads re-handshakes and the conversation continues', async (t) => {
  const got: string[] = []
  const { A, B, rejoinB } = await rooms({ collect: got })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  A.sendText('przed reloadem')
  await until(() => got.length === 1)

  // B reloads: same identity key, fresh room state and a new ephemeral PeerId
  // ('peer-c' > 'peer-a', so A initiates again). A must accept the new peer
  // while still holding the old session.
  B.stop()
  const got2: string[] = []
  const B2 = rejoinB('peer-c', got2)
  t.after(() => { A.stop(); B2.stop() })

  await until(() => A.secured().includes('peer-c') && B2.secured().includes('peer-a'), 8000)
  A.sendText('po reloadzie')
  await until(() => got2.length === 1)
  assert.deepEqual(got2, ['po reloadzie'])
})

test('a repeated msg1 is answered, not restarted (no established/handshaking loop)', async (t) => {
  // The initiator re-sends msg1 while it waits. If that restarted the responder,
  // the initiator's msg3 would arrive against a transcript the responder had
  // already thrown away — mac_i fails, both sides retry, and the badge flips
  // between green and orange forever. Seen live; this pins the fix.
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got, duplicate: (d) => d[0] === 0x01 })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  await new Promise((r) => setTimeout(r, 1500)) // let any loop show itself
  assert.equal(states.filter((s) => s.endsWith(':failed')).length, 0, `no failures: ${states.join(' ')}`)
  assert.equal(states.filter((s) => s.endsWith(':established')).length, 2, `one establish per side: ${states.join(' ')}`)
  assert.ok(A.secured().length === 1 && B.secured().length === 1, 'both still hold a session')

  A.sendText('po duplikacie')
  await until(() => got.length === 1)
})

test('interim mode is untouched (no eh2 → static key, no handshake frames)', async (t) => {
  const net = hub()
  const ss = new Uint8Array(32).fill(0x11)
  const keys = { macKey: await announceMacKey(ss, P), session: await interimSession(ss, P) }
  const got: string[] = []
  const A = joinChat(net.node('peer-a'), TOPIC, keys, { firstAnnounceMs: 5 })
  const B = joinChat(net.node('peer-b'), TOPIC, keys, { firstAnnounceMs: 5, onMessage: (_f, m) => got.push(m.body) })
  t.after(() => { A.stop(); B.stop() })

  A.sendText('stara droga')
  await until(() => got.length === 1)
  assert.deepEqual(got, ['stara droga'])
  assert.deepEqual(A.secured(), [], 'no EH-2 sessions in interim mode')
})
