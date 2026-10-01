import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A node whose every publish answers with `result`, and that delivers nothing. */
function node(result: any) {
  return {
    peerId: { toString: () => 'me' },
    services: { pubsub: {
      addEventListener: () => {}, removeEventListener: () => {},
      subscribe: () => {}, unsubscribe: () => {},
      getSubscribers: () => ['relay'],
      publish: async () => result,
    } },
  }
}

test('alone in a room behind a relay that answers is not "the transport is dead"', async () => {
  // 2026-09-29: a light client waiting for its contact got ACK reach 0 on every
  // heartbeat (the relay counts only the OTHER holders), declared itself
  // isolated after two, hung up and hopped relays - over and over.
  const macKey = await announceMacKey(new Uint8Array(32).fill(7), { networkId: 'test', dateUTC: '2026-09-29' })
  for (const [result, expectIsolated, label] of [
    [{ recipients: [], acked: true }, false, 'the relay acknowledged, nobody else is here'],
    [{ recipients: [] }, true, 'no acknowledgement and no recipients (GossipSub zero)'],
  ] as const) {
    let isolated = 0
    const room = joinChat(node(result), 'T', { macKey } as any, { heartbeatMs: 25, firstAnnounceMs: 5, onIsolated: () => { isolated++ } })
    await sleep(250)
    room.stop()
    assert.equal(isolated > 0, expectIsolated, `${label}: isolated ${isolated}x`)
  }
})

test('a room moves to another topic in place: new subscribed, old released, announces go to the new one', async () => {
  const macKey = await announceMacKey(new Uint8Array(32).fill(7), { networkId: 'test', dateUTC: '2026-10-01' })
  const subs = new Set<string>(), published: string[] = []
  const n = {
    peerId: { toString: () => 'me' },
    services: { pubsub: {
      addEventListener: () => {}, removeEventListener: () => {},
      subscribe: (t: string) => { subs.add(t) }, unsubscribe: (t: string) => { subs.delete(t) },
      getSubscribers: () => ['relay'],
      publish: async (t: string) => { published.push(t); return { recipients: [], acked: true } },
    } },
  }
  const room: any = joinChat(n, 'day-1', { macKey } as any, { heartbeatMs: 20, firstAnnounceMs: 5 })
  await sleep(60)
  assert.equal(room.currentTopic(), 'day-1')
  assert.equal(room.retarget('day-1', macKey), false, 'the same topic is no move')
  published.length = 0
  assert.equal(room.retarget('day-2', macKey), true)
  await sleep(60)
  room.stop()
  assert.equal(room.currentTopic(), 'day-2')
  assert.ok(!subs.has('day-1'), 'the old topic is released')
  assert.ok(published.length > 0 && published.every((t) => t === 'day-2'), `everything after the move goes to the new topic: ${published}`)
})
