import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectSdp, candidateTypes, probeWebrtc, formatWebrtcProbe } from '../lib/webrtc-probe.ts'

const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:4ZcD',
  'a=fingerprint:sha-256 AB:CD',
].join('\r\n')

test('inspectSdp finds the three things an offer must carry', () => {
  assert.deepEqual(inspectSdp(OFFER), { app: true, dtls: true, ice: true })
})

test('inspectSdp is not fooled by the words appearing elsewhere', () => {
  // A stack that negotiates audio and no data channel produces exactly this,
  // and it is the difference between "WebRTC works" and "WebRTC works for
  // something we do not use".
  const audioOnly = OFFER.replace('m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'm=audio 9 UDP/TLS/RTP/SAVPF 111')
  assert.equal(inspectSdp(audioOnly).app, false)
  assert.equal(inspectSdp(audioOnly).dtls, true)
  // The anchors matter: a session name mentioning it is not a media section.
  assert.equal(inspectSdp('v=0\r\ns=m=application in the name\r\n').app, false)
})

test('candidateTypes counts by kind, and ignores lines with no type', () => {
  assert.deepEqual(candidateTypes([
    'candidate:1 1 udp 2122 192.168.1.2 50000 typ host',
    'candidate:2 1 udp 2122 10.0.0.4 50001 typ host',
    'candidate:3 1 udp 1686 203.0.113.9 50002 typ srflx raddr 192.168.1.2',
    'a=end-of-candidates',
  ]), { host: 2, srflx: 1 })
})

test('a platform with no RTCPeerConnection is REPORTED, not thrown at', async () => {
  // Node is that platform, which is what makes this test possible at all: the
  // probe has to survive the case it exists to describe. A probe that throws
  // turns a diagnosis into a second bug.
  const r = await probeWebrtc()
  assert.equal(r.ok, false)
  assert.equal(r.reflexive, false)
  assert.equal(r.stages.length, 6, 'every stage is accounted for, including the skipped ones')
  assert.ok(r.stages.every((s) => !s.ok))
  assert.match(r.stages[0].error ?? '', /RTCPeerConnection/)
  // The network stage must stay labelled as such even when it never ran —
  // telling "this webview cannot" from "this network cannot" is the point.
  assert.equal(r.stages.at(-1)!.id, 'stun')
  assert.equal(r.stages.at(-1)!.about, 'network')
})

test('the report names every stage and says which half failed', async () => {
  const text = formatWebrtcProbe(await probeWebrtc())
  assert.match(text, /platforma NIE UMIE/)
  for (const id of ['construct', 'datachannel', 'sdp', 'ice', 'loopback', 'stun']) {
    assert.ok(text.includes(`[fail] ${id} `), text) // a literal, not a regex: [fail] is a character class
  }
})

test('onStage reports as it goes, not only at the end', async () => {
  const seen: string[] = []
  await probeWebrtc((s) => seen.push(s.id))
  assert.deepEqual(seen, ['construct', 'datachannel', 'sdp', 'ice', 'loopback', 'stun'])
})
