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
