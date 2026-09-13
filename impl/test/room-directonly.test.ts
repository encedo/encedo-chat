/**
 * "Direct only" makes a NEGATIVE promise — content never reaches the node — and
 * a negative promise has to be watched on the wire, not inferred from an
 * outcome. Two rooms meet over a mock pubsub, complete EH-2 through it, and
 * then the question is only ever: what did the node carry afterwards.
 *
 * The trap this file walked into first: with no session established, NOTHING is
 * sent in either mode, so an assertion about silence passes for the wrong
 * reason. Every test here waits for a live ratchet before it means anything.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'

const TOPIC = 'direct-only-topic'
const P = { networkId: 'test', dateUTC: '2026-09-13' }
const CONTENT = 0x10   // eh2/ratchet.ts T_DATA — the first byte of a sealed message

/** A hub that also records, per sender, everything that crossed it. */
function hub() {
  const nodes = new Map<string, (t: string, d: Uint8Array, from: string) => void>()
  const sent = new Map<string, Uint8Array[]>()
  return {
    sent,
    node(id: string) {
      const listeners: Array<(e: any) => void> = []
      sent.set(id, [])
      nodes.set(id, (topic, data, from) => {
        for (const h of listeners) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (e: any) => void) => listeners.push(h),
            removeEventListener: (_e: string, h: (e: any) => void) => {
              const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1)
            },
            subscribe: () => {}, unsubscribe: () => {},
            getSubscribers: () => [...nodes.keys()].filter((k) => k !== id).map((k) => ({ toString: () => k })),
            publish: async (topic: string, data: Uint8Array) => {
              sent.get(id)!.push(data)
              for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
              return { recipients: [1] }
            },
          },
        },
      } as any
    },
  }
}

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${Date.now() - t0} ms waiting for: ${cond}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Two rooms that have actually handshaked. `directOnly` applies to A. */
async function meet(directOnly: boolean) {
  const net = hub()
  const ss = new Uint8Array(32).fill(0x5e)
  const macKey = await announceMacKey(ss, P)
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const heard: string[] = []
  const A = joinChat(net.node('peer-a'), TOPIC, { macKey, eh2: { ik: ikA, peerIkPub: ikB.pub, attemptTimeoutMs: 400 } },
    { firstAnnounceMs: 5, contentDirectOnly: directOnly })
  const B = joinChat(net.node('peer-b'), TOPIC, { macKey, eh2: { ik: ikB, peerIkPub: ikA.pub, attemptTimeoutMs: 400 } },
    { firstAnnounceMs: 5, onMessage: (_f, m) => heard.push(m.body) })
  await until(() => A.secured().length === 1 && B.secured().length === 1)
  const contentFromA = () => net.sent.get('peer-a')!.filter((b) => b[0] === CONTENT).length
  return { A, B, heard, contentFromA, stop: () => { A.stop(); B.stop() } }
}

test('ordinary mode: with no channel, content goes through the node and arrives', async () => {
  // The control. Without this the tests below prove only that nothing happened.
  const { A, heard, contentFromA, stop } = await meet(false)
  A.sendText('przez wezel')
  await until(() => heard.includes('przez wezel'))
  assert.ok(contentFromA() > 0, 'the node carried nothing, so the contrast means nothing')
  stop()
})

test('direct-only: with no channel, the node carries no content and the peer hears nothing', async () => {
  const { A, heard, contentFromA, stop } = await meet(true)
  A.sendText('nikt tego nie ma prawa zobaczyc')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(contentFromA(), 0, 'content reached the node in direct-only mode')
  assert.deepEqual(heard, [], 'the peer received content that was supposed to be held')
  stop()
})

test('direct-only: the handshake and presence still use the node', async () => {
  // The mode narrows the DATA plane only. A room that stopped announcing would
  // never meet anybody, and `meet()` above would not have returned at all.
  const { A, stop } = await meet(true)
  assert.equal(A.secured().length, 1)
  stop()
})

test('direct-only: a live channel carries it, and the node still sees nothing', async () => {
  const { A, contentFromA, stop } = await meet(true)
  const direct: Uint8Array[] = []
  A.setContentSend((sealed) => direct.push(sealed))
  A.sendText('tedy')
  await until(() => direct.length > 0)
  assert.equal(contentFromA(), 0, 'content leaked to the node while a channel existed')
  stop()
})

test('direct-only: losing the channel holds content instead of restoring the relay', async () => {
  // The case the mode exists for. In ordinary mode setContentSend(null) means
  // "relay from here on"; here it has to mean "hold".
  const { A, heard, contentFromA, stop } = await meet(true)
  A.setContentSend((s) => { void s })
  A.setContentSend(null)                      // demoted, or the link died
  A.sendText('po zerwaniu kanalu')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(contentFromA(), 0, 'a dead channel quietly restored the relay')
  assert.deepEqual(heard, [])
  stop()
})
