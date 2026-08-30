/**
 * The WebRTC upgrader (net/webrtc-plane.ts) — the decisions it makes ABOUT the
 * direct data plane, with the plane itself faked out.
 *
 * `RTCPeerConnection` does not exist in Node, so the real link is injected
 * (`makeLink`). What is under test is not WebRTC: it is which PeerId we address,
 * when we give a negotiation up, and what we tell the user — the three things
 * that put a live conversation on the relay for good and left no trace.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachWebRTC } from '../net/webrtc-plane.ts'

/** A link that does nothing until the test says so. */
function fakeLink() {
  const links: any[] = []
  const makeLink = (o: any) => {
    const l = {
      opts: o,
      ready: false,
      closed: false,
      signals: [] as any[],
      handleSignal: async (s: any) => { l.signals.push(s) },
      send: () => {},
      close: () => { l.closed = true },
      /** Pretend the ping/pong round trip came back. */
      open: () => { l.ready = true; o.onOpen?.() },
    }
    links.push(l)
    return l as any
  }
  return { links, makeLink: makeLink as any }
}

function room() {
  const sent: Array<{ to: string; sig: any }> = []
  let contentSend: any = null
  return {
    sent,
    get contentSend() { return contentSend },
    sendSignal: (to: string, sig: any) => sent.push({ to, sig }),
    setContentSend: (fn: any) => { contentSend = fn },
    injectContent: () => {},
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a peer that comes back under a new PeerId gets a new link', async () => {
  // The failure this pins: the plane kept its first link forever, so after the
  // peer reloaded every offer was addressed to a PeerId nobody answered to.
  const { links, makeLink } = fakeLink()
  const r = room()
  const plane = attachWebRTC(r as any, 'peer-a', { makeLink, attemptMs: 50 })

  plane.onPeer('peer-z')
  assert.equal(links.length, 1)
  links[0].open()
  assert.ok(r.contentSend, 'content moves to the channel once it proves itself')

  plane.onPeer('peer-y') // same person, new PeerId
  assert.equal(links.length, 2, 'a new link, not the old one')
  assert.equal(links[0].closed, true, 'and the dead one is closed')
  assert.equal(r.contentSend, null, 'content goes back to the relay until the new one proves itself')

  plane.stop()
})

test('an offer nobody answers is made again, then given up', async () => {
  // Signalling rides GossipSub and is fire-and-forget: nothing here used to
  // retry, so one lost offer meant the relay for the rest of the conversation.
  //
  // ⚠️ This used to `await tick(140)` and assert 3 — the documented flake
  // shape (CLAUDE.md): three 40 ms timers fire sequentially, so a full-suite
  // event-loop stall between any two of them pushes the third past a fixed
  // wall-clock deadline. Wait on the CONDITION, then prove "given up" with a
  // margin that only has to catch a wrong FOURTH attempt, not to race a stall.
  const { links, makeLink } = fakeLink()
  const states: string[] = []
  const plane = attachWebRTC(room() as any, 'peer-a', {
    makeLink, attemptMs: 40, onState: (s) => states.push(s),
  })

  plane.onPeer('peer-z') // we are the lower id → we offer
  const deadline = Date.now() + 5_000
  while (links.length < 3 && Date.now() < deadline) await tick(10)
  assert.equal(links.length, 3, 'the offer is made three times in all')
  assert.equal(states.filter((s) => s.includes('offering again')).length, 2)

  await tick(120) // three attempt windows past the last offer
  assert.equal(links.length, 3, 'then it stops trying')

  plane.stop()
})

test('a channel that opens stops the retries', async () => {
  const { links, makeLink } = fakeLink()
  const plane = attachWebRTC(room() as any, 'peer-a', { makeLink, attemptMs: 40 })
  plane.onPeer('peer-z')
  links[0].open()
  await tick(140)
  assert.equal(links.length, 1, 'a working channel is not thrown away')
  plane.stop()
})

test('the answering side never restarts the negotiation', async () => {
  // Both sides run this code. Only the offerer can re-offer; a responder that
  // "retried" would tear down the channel the other side is negotiating.
  const { links, makeLink } = fakeLink()
  const plane = attachWebRTC(room() as any, 'peer-z', { makeLink, attemptMs: 40 }) // higher id
  plane.onPeer('peer-a')
  await tick(140)
  assert.equal(links.length, 1)
  plane.stop()
})

test('a signal addressed to someone else is reported, not swallowed', async () => {
  const { makeLink } = fakeLink()
  const states: string[] = []
  const plane = attachWebRTC(room() as any, 'peer-a', { makeLink, onState: (s) => states.push(s) })

  plane.onSignal('peer-z', { to: 'peer-OLD', sig: { kind: 'offer', sdp: 'x' } as any })
  assert.ok(states.some((s) => s.includes('dropped')), 'this is the fingerprint of a stale peer — say it')

  plane.stop()
})

test('a demoted plane stays on the relay and stops negotiating', async () => {
  const { links, makeLink } = fakeLink()
  const r = room()
  const plane = attachWebRTC(r as any, 'peer-a', { makeLink, attemptMs: 40 })
  plane.onPeer('peer-z')
  plane.demote()
  await tick(140)
  assert.equal(links.length, 1, 'no further attempts after content stopped being confirmed')
  links[0].open()
  assert.equal(r.contentSend, null, 'and even an open channel does not get content back')
  plane.stop()
})

test('a channel that dies says so, so the badge cannot keep claiming Direct', async () => {
  // The transport badge is a security indicator: Direct means the peer sees
  // your IP, Relay means the node sees the metadata. Reported from a phone that
  // left Wi-Fi — messages kept flowing over the relay while the badge still
  // read Direct, because closing the channel handed content back to GossipSub
  // and told nobody. Content falling back and the UI saying so must be one act.
  const r = room()
  const states: string[] = []
  const { links, makeLink } = fakeLink()
  const plane = attachWebRTC(r as any, 'peer-a', { makeLink, attemptMs: 10_000, onState: (s) => states.push(s) })
  plane.onPeer('peer-b')
  links[0].open()
  assert.ok(r.contentSend, 'content is on the DataChannel once it opens')

  links[0].opts.onClose?.()
  assert.equal(r.contentSend, null, 'content went back to the relay')
  assert.ok(states.some((s) => s.startsWith('conn=') && !s.startsWith('conn=connected')),
    `the UI was told the channel is gone — got ${JSON.stringify(states)}`)
})

test('demoting also reports a state the UI acts on', async () => {
  // `demoted=relay` was emitted but the app only matched a `conn=` prefix, so a
  // stalled channel left the badge reading Direct for the rest of the
  // conversation. The string is part of the contract, not just a log line.
  const r = room()
  const states: string[] = []
  const { links, makeLink } = fakeLink()
  const plane = attachWebRTC(r as any, 'peer-a', { makeLink, attemptMs: 10_000, onState: (s) => states.push(s) })
  plane.onPeer('peer-b')
  links[0].open()
  plane.demote()
  assert.equal(r.contentSend, null)
  assert.ok(states.some((s) => s.startsWith('demoted=')), `got ${JSON.stringify(states)}`)
})
