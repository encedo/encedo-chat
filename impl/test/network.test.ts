import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNetworkProfile, sigUrl } from '../lib/network.ts'

const shipped = JSON.parse(readFileSync(new URL('../../infra/network.json', import.meta.url), 'utf8'))

test('the shipped profile parses, and says what the clients used to hard-code', () => {
  // These are the values the app and the CLI carried as constants before the
  // profile existed. A change here moves every client's store, manifest,
  // feedback and invite links - make it on purpose, never by accident.
  const p = parseNetworkProfile(shipped)
  assert.equal(p.networkId, 'main')
  assert.deepEqual(p.app, { origin: 'https://app.onchato.com', path: '/' })
  assert.deepEqual(p.legacyApp, [{ origin: 'https://onchato.com', path: '/chat' }])
  assert.deepEqual(p.stores, ['https://onchato.com'])
  assert.deepEqual(p.manifestUrls, ['https://onchato.com/release/manifest.json'])
  assert.equal(sigUrl(p.manifestUrls[0]), 'https://onchato.com/release/manifest.sig')
  assert.equal(p.feedback, 'https://onchato.com/feedback')
  assert.equal(p.home, 'https://onchato.com/')
})

test('origins come back without a trailing slash, and legacyApp may be absent', () => {
  const p = parseNetworkProfile({ ...shipped, stores: ['https://files.example.org/'], legacyApp: undefined })
  assert.deepEqual(p.stores, ['https://files.example.org'])
  assert.deepEqual(p.legacyApp, [])
})

test('http is accepted only on loopback, for a developer\'s own store', () => {
  assert.deepEqual(parseNetworkProfile({ ...shipped, stores: ['http://127.0.0.1:9202'] }).stores, ['http://127.0.0.1:9202'])
  assert.throws(() => parseNetworkProfile({ ...shipped, stores: ['http://files.example.org'] }), /must be https/)
})

test('a profile that would point a client at half a network is refused, with the reason', () => {
  const bad: [string, unknown, RegExp][] = [
    ['not an object', null, /not an object/],
    ['unknown version', { ...shipped, v: 2 }, /unknown version/],
    ['no networkId', { ...shipped, networkId: '' }, /networkId/],
    ['networkId with a space', { ...shipped, networkId: 'my net' }, /networkId/],
    ['no operator', { ...shipped, operator: '  ' }, /operator/],
    ['app with a path in the origin', { ...shipped, app: { origin: 'https://a.example/x', path: '/' } }, /bare origin/],
    ['app path without a slash', { ...shipped, app: { origin: 'https://a.example', path: 'x' } }, /path must start/],
    ['no stores', { ...shipped, stores: [] }, /stores is empty/],
    ['a store with a path', { ...shipped, stores: ['https://a.example/f'] }, /bare origin/],
    ['a store with credentials', { ...shipped, stores: ['https://u:p@a.example'] }, /credentials/],
    ['too many stores', { ...shipped, stores: Array.from({ length: 9 }, (_, i) => `https://s${i}.example`) }, /more than 8/],
    ['a manifest that is not .json', { ...shipped, manifestUrls: ['https://a.example/manifest'] }, /\.json/],
    ['a feedback URL with a query', { ...shipped, feedback: 'https://a.example/fb?to=x' }, /query or fragment/],
    ['no home', { ...shipped, home: undefined }, /home is missing/],
  ]
  for (const [name, raw, why] of bad) assert.throws(() => parseNetworkProfile(raw), why, name)
})
