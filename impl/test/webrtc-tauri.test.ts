/**
 * The Rust-backed link, against a fake Tauri host. What is under test is the
 * CONTRACT it shares with the browser link: the order of the opening moves,
 * that `ready` waits for the pong, that 0x00 frames are control and the rest
 * is content, and that a send is one IPC call carrying base64 and the id. The host itself is proven by `rtc_selftest` and the spike.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webrtcLinkTauri, tauriRtcAvailable } from '../net/webrtc-tauri.ts'

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
/** What a send put on the wire, decoded — sends are base64 in a JSON argument. */
const sentBytes = (c: { args: any }) => new Uint8Array(Buffer.from(c.args.b64, 'base64'))

/** A host that records every command and answers from a script. */
function fakeHost() {
  const calls: Array<{ cmd: string; args: any; headers?: any }> = []
  const queue: any[] = []
  const overrides = new Map<string, () => Promise<any>>()
  let buffered = 0
  ;(globalThis as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any, options?: any) => {
      calls.push({ cmd, args, headers: options?.headers })
      const over = overrides.get(cmd)
      if (over) return over()
      switch (cmd) {
        case 'rtc_available': return true
        case 'rtc_offer': return 'v=0 offer'
        case 'rtc_answer': return 'v=0 answer'
        case 'rtc_poll': return { events: queue.splice(0), buffered }
        default: return null
      }
    },
  }
  return {
    calls, push: (ev: any) => queue.push(ev), setBuffered: (n: number) => { buffered = n },
    onCall: (cmd: string, fn: () => Promise<any>) => overrides.set(cmd, fn),
    sent: () => calls.filter((c) => c.cmd === 'rtc_send'),
    stop: () => { delete (globalThis as any).__TAURI_INTERNALS__ },
  }
}
// Longer than the link's idle poll (100 ms): every wait here is about the
// contract, never about winning a race with the timer. Two tests flaked on
// 60 ms before this became the default.
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))

test('the offering side creates, offers, and sends the offer out', async () => {
  const host = fakeHost()
  const signals: any[] = []
  const link = webrtcLinkTauri({ initiator: true, sendSignal: (s) => signals.push(s), onData: () => {} })
  await tick()
  const cmds = host.calls.map((c) => c.cmd)
  assert.deepEqual(cmds.slice(0, 2), ['rtc_create', 'rtc_offer'])
  assert.equal(host.calls[0].args.initiator, true)
  assert.deepEqual(signals[0], { kind: 'offer', sdp: 'v=0 offer' })
  link.close(); host.stop()
})

test('the answering side waits for an offer and answers it', async () => {
  const host = fakeHost()
  const signals: any[] = []
  const link = webrtcLinkTauri({ initiator: false, sendSignal: (s) => signals.push(s), onData: () => {} })
  await tick()
  assert.ok(!host.calls.some((c) => c.cmd === 'rtc_offer'), 'the answering side must not offer')
  await link.handleSignal({ kind: 'offer', sdp: 'v=0 their-offer' })
  assert.deepEqual(signals, [{ kind: 'answer', sdp: 'v=0 answer' }])
  assert.equal(host.calls.find((c) => c.cmd === 'rtc_answer')?.args.sdp, 'v=0 their-offer')
  link.close(); host.stop()
})

test('ready only after the pong, and the ping is the browser link\'s bytes', async () => {
  const host = fakeHost()
  let opened = 0
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: () => {}, onOpen: () => { opened++ } })
  await tick()
  host.push({ t: 'open' })
  await tick()
  assert.equal(link.ready, false, 'open alone must not mean ready')
  const ping = host.sent()[0]
  assert.ok(ping, 'no ping was sent after open')
  assert.deepEqual([...sentBytes(ping)], [0x00, 0x50])
  assert.equal(ping.args.id, host.calls[0].args.id)
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x4f])) })
  await tick()
  assert.equal(link.ready, true)
  assert.equal(opened, 1)
  link.close(); host.stop()
})

test('control frames and content go to different places, like the browser link', async () => {
  const host = fakeHost()
  const data: Uint8Array[] = [], ctrl: Uint8Array[] = []
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: (b) => data.push(b), onControl: (b) => ctrl.push(b) })
  await tick()
  host.push({ t: 'open' }); await tick()
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x4f])) }); await tick()
  host.push({ t: 'data', b64: b64(new Uint8Array([0x10, 1, 2, 3])) })          // a ratchet frame
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x04, 9, 9, 9, 9])) })  // a transfer frame
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x50])) })              // their ping
  await tick()
  assert.equal(data.length, 1); assert.equal(data[0][0], 0x10)
  assert.equal(ctrl.length, 1); assert.equal(ctrl[0][1], 0x04)
  const pong = host.sent().find((c) => sentBytes(c)[1] === 0x4f)
  assert.ok(pong, 'their ping was not answered')
  link.close(); host.stop()
})

test('a send before ready is dropped, after ready it is one call per frame, in order', async () => {
  const host = fakeHost()
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: () => {} })
  await tick()
  link.send(new Uint8Array([0x10, 7]))
  assert.equal(host.sent().length, 0, 'sent content on a channel that has not proven itself')
  host.push({ t: 'open' }); await tick()
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x4f])) }); await tick()
  const before = host.sent().length
  for (let i = 0; i < 5; i++) link.send(new Uint8Array([0x10, i]))
  const mine = host.sent().slice(before)
  assert.deepEqual(mine.map((c) => sentBytes(c)[1]), [0, 1, 2, 3, 4])
  assert.ok(mine.every((c) => typeof c.args.b64 === 'string' && c.args.id === host.calls[0].args.id), 'a send is base64 in JSON with the id')
  link.close(); host.stop()
})

test('drain waits while the host is full and returns when it says low', async () => {
  const host = fakeHost()
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: () => {} })
  await tick()
  // Idle polling runs every 100 ms, so each step here waits longer than that:
  // the assertion is about the contract, not about winning a race with the timer.
  host.setBuffered(64 * 1024 * 1024); await tick(150)
  let drained = false
  void link.drain().then(() => { drained = true })
  await tick(150)
  assert.equal(drained, false)
  host.setBuffered(0); host.push({ t: 'low' }); await tick(150)
  assert.equal(drained, true)
  link.close(); host.stop()
})

test('close tells the host and reports the loss once', async () => {
  const host = fakeHost()
  let closes = 0
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: () => {}, onClose: () => { closes++ } })
  await tick()
  host.push({ t: 'open' }); await tick()
  host.push({ t: 'data', b64: b64(new Uint8Array([0x00, 0x4f])) }); await tick()
  link.close()
  await tick()
  assert.equal(closes, 1)
  assert.ok(host.calls.some((c) => c.cmd === 'rtc_close'))
  host.stop()
})

test('availability is asked once and answered from the host', async () => {
  const host = fakeHost()
  assert.equal(await tauriRtcAvailable(), true)
  assert.equal(host.calls.filter((c) => c.cmd === 'rtc_available').length, 1)
  await tauriRtcAvailable()
  assert.equal(host.calls.filter((c) => c.cmd === 'rtc_available').length, 1, 'asked twice')
  host.stop()
})

test('ICE that arrives before the remote description waits for it', async () => {
  // The browser link holds candidates until setRemoteDescription; webrtc-rs is
  // just as strict, so a candidate forwarded early would be refused and lost.
  const host = fakeHost()
  const link = webrtcLinkTauri({ initiator: false, sendSignal: () => {}, onData: () => {} })
  // No await: the plane can hand us signals in the same tick it built us.
  void link.handleSignal({ kind: 'ice', candidate: { candidate: 'a=1' } as any })
  void link.handleSignal({ kind: 'ice', candidate: { candidate: 'a=2' } as any })
  await tick()
  assert.equal(host.calls.filter((c) => c.cmd === 'rtc_ice').length, 0, 'a candidate went out before the offer')
  await link.handleSignal({ kind: 'offer', sdp: 'v=0 their-offer' })
  await tick()
  const cmds = host.calls.map((c) => c.cmd)
  const iAnswer = cmds.indexOf('rtc_answer'), iIce = cmds.indexOf('rtc_ice')
  assert.ok(iAnswer !== -1 && iIce > iAnswer, `order was ${cmds.join(',')}`)
  assert.equal(host.calls.filter((c) => c.cmd === 'rtc_ice').length, 2)
  // And once the description is in, candidates go straight through.
  await link.handleSignal({ kind: 'ice', candidate: { candidate: 'a=3' } as any })
  assert.equal(host.calls.filter((c) => c.cmd === 'rtc_ice').length, 3)
  link.close(); host.stop()
})

test('a candidate the host emits while the offer is still being made goes out AFTER the offer', async () => {
  // webrtc-rs emits its first candidates during set_local_description, so the
  // poll loop can see them before rtc_offer has returned. A candidate that
  // reaches the peer first describes a session it has not been told about.
  const host = fakeHost()
  const signals: any[] = []
  host.onCall('rtc_offer', async () => {
    host.push({ t: 'ice', candidate: { candidate: 'a=1' } })
    await tick(200)                      // long enough for the poll loop to drain it
    return 'v=0 offer'
  })
  const link = webrtcLinkTauri({ initiator: true, sendSignal: (s) => signals.push(s), onData: () => {} })
  await tick(500)
  assert.equal(signals[0]?.kind, 'offer', `the first signal out was ${signals[0]?.kind}`)
  assert.ok(signals.some((s) => s.kind === 'ice'), 'the held candidate was never sent at all')
  link.close(); host.stop()
})

test('the host\'s ICE vocabulary reaches the diary, with the candidate counts', async () => {
  const host = fakeHost()
  const states: string[] = []
  const link = webrtcLinkTauri({ initiator: true, sendSignal: () => {}, onData: () => {}, onState: (s) => states.push(s) })
  await tick()
  host.push({ t: 'state', gather: 'gathering' })
  host.push({ t: 'state', ice: 'checking' })
  host.push({ t: 'state', conn: 'connecting', out: 4, in: 0 })
  host.push({ t: 'state', 'ice-error': '701 no route (stun:bs1:3478)' })
  await tick()
  assert.ok(states.includes('gather=gathering'), states.join(','))
  assert.ok(states.includes('ice=checking'), states.join(','))
  // The count is the whole point: gathered four, received none of theirs.
  assert.ok(states.includes('conn=connecting cand 4/0'), states.join(','))
  assert.ok(states.some((s) => s.startsWith('ice-error: 701')), states.join(','))
  link.close(); host.stop()
})
