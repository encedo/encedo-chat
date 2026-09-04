/**
 * Which STUN servers a build is willing to talk to.
 *
 * This list is the answer to "does this product depend on anybody?", so the
 * test is mostly about what a URL parameter is NOT allowed to turn it into.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ICE_SERVERS, PROBE_STUN, STUN_HOSTS, iceServersFor } from '../lib/ice.ts'

test('the shipped list is our own nodes, and nobody else', () => {
  assert.deepEqual(STUN_HOSTS, ['bs1.onchato.com', 'bs2.onchato.com', 'bs3.onchato.com'])
  for (const s of ICE_SERVERS) assert.match(s.urls, /^stun:bs[123]\.onchato\.com:3478$/)
  assert.equal(ICE_SERVERS.length, 3, 'three nodes: one reflexive answer is enough, so one being down costs nothing')
  assert.equal(PROBE_STUN, ICE_SERVERS[0].urls, 'the self-test must dial what the app dials')
})

test('no third party can be reintroduced by a URL', () => {
  // The value goes straight into RTCPeerConnection, so `turn:` from a link
  // would send this conversation's media somewhere a URL chose.
  for (const bad of ['turn:evil.example:3478', 'turns:evil.example', 'http://evil.example', 'javascript:1', 'stun evil']) {
    assert.deepEqual(iceServersFor(`?stun=${encodeURIComponent(bad)}`), ICE_SERVERS, bad)
  }
})

test('a STUN url is honoured, for a node that is not in a build yet', () => {
  assert.deepEqual(iceServersFor('?stun=stun:bs4.onchato.com:3478'), [{ urls: 'stun:bs4.onchato.com:3478' }])
  assert.deepEqual(iceServersFor('?stun=stuns:bs4.onchato.com:5349'), [{ urls: 'stuns:bs4.onchato.com:5349' }])
})

test('?stun=0 means none — host candidates only', () => {
  assert.deepEqual(iceServersFor('?stun=0'), [])
  // Absent or empty is the default, not "none".
  assert.deepEqual(iceServersFor(''), ICE_SERVERS)
  assert.deepEqual(iceServersFor('?debug=1'), ICE_SERVERS)
  assert.deepEqual(iceServersFor('?stun='), ICE_SERVERS)
})
