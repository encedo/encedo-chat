/**
 * Which STUN servers a build is willing to talk to.
 *
 * The answer must keep being "the nodes this client already dials", so the
 * tests are about the derivation and about what a URL parameter is NOT allowed
 * to turn it into.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STUN, STUN_PORT, hostOf, iceServersFor, stunFromNodes } from '../lib/ice.ts'
import published from '../../infra/nodes.json' with { type: 'json' }

const A = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWA'
const B = '/dns4/bs2.onchato.com/tcp/443/wss/p2p/12D3KooWB'
const C = '/dns4/bs3.onchato.com/tcp/443/wss/p2p/12D3KooWC'
const D = '/dns4/bs4.onchato.com/tcp/443/wss/p2p/12D3KooWD'

test('the servers are the nodes, on the default port', () => {
  assert.deepEqual(stunFromNodes([A, B]), [
    { urls: `stun:bs1.onchato.com:${STUN_PORT}` },
    { urls: `stun:bs2.onchato.com:${STUN_PORT}` },
  ])
})

test('the published list yields servers without anyone writing hosts twice', () => {
  // The point of deriving: `infra/nodes.json` is edited when a node joins
  // (relay/DEPLOY.md §9) and this follows it. A hardcoded list is the drift
  // this project already paid for once with DEFAULT_NODES.
  const got = stunFromNodes(published.nodes.map((n: any) => n.addr))
  assert.ok(got.length >= 2, 'the published list should give at least two')
  for (const s of got) assert.match(s.urls, new RegExp(`^stun:[a-z0-9.-]+:${STUN_PORT}$`))
})

test('only a few are asked, in the order they are dialled', () => {
  const got = stunFromNodes([A, B, C, D])
  assert.equal(got.length, MAX_STUN, 'every extra server is another round trip for the same answer')
  assert.equal(got[0].urls, `stun:bs1.onchato.com:${STUN_PORT}`)
})

test('duplicates and unusable addresses fall out', () => {
  assert.deepEqual(stunFromNodes([A, A, 'bs9.onchato.com', '', '/tcp/443']), [
    { urls: `stun:bs1.onchato.com:${STUN_PORT}` },
  ])
  assert.equal(hostOf('/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWX'), '127.0.0.1')
  assert.equal(hostOf('/dns6/bs1.onchato.com/tcp/443/wss/p2p/x'), 'bs1.onchato.com')
  assert.equal(hostOf('bs1.onchato.com'), null, 'a bare hostname is not a multiaddr')
})

test('no third party can be reintroduced by a URL', () => {
  // The value goes straight into RTCPeerConnection, so `turn:` from a link
  // would route this conversation's media somewhere a link chose.
  for (const bad of ['turn:evil.example:3478', 'turns:evil.example', 'http://evil.example', 'javascript:1', 'stun evil']) {
    assert.deepEqual(iceServersFor(`?stun=${encodeURIComponent(bad)}`, [A, B]), stunFromNodes([A, B]), bad)
  }
})

test('a STUN url is honoured, for a node that is not in a build yet', () => {
  assert.deepEqual(iceServersFor('?stun=stun:bs4.onchato.com:3478', [A]), [{ urls: 'stun:bs4.onchato.com:3478' }])
  assert.deepEqual(iceServersFor('?stun=stuns:bs4.onchato.com:5349', [A]), [{ urls: 'stuns:bs4.onchato.com:5349' }])
})

test('?stun=0 means none — host candidates only', () => {
  assert.deepEqual(iceServersFor('?stun=0', [A, B]), [])
  assert.deepEqual(iceServersFor('', [A]), stunFromNodes([A]))
  assert.deepEqual(iceServersFor('?debug=1', [A]), stunFromNodes([A]))
  assert.deepEqual(iceServersFor('?stun=', [A]), stunFromNodes([A]))
  assert.deepEqual(iceServersFor('', []), [], 'no nodes, nothing to ask')
})
