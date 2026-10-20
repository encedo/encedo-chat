import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { enrollDevice, deviceStatus, enrollUrl, enrollMessage, statusMessage } from '../lib/enroll.ts'
// @ts-ignore - the node side, plain .mjs
import * as node from '../../relay/enroll.mjs'

test('the device signs exactly what the node checks', () => {
  assert.deepEqual(enrollMessage('acme', 'n1', '12345678'), node.enrollMessage('acme', 'n1', '12345678'))
  assert.deepEqual(statusMessage('acme', 'n1'), node.statusMessage('acme', 'n1'))
})

test('the enrol address is the first node\'s host', () => {
  assert.equal(enrollUrl({ nodes: [{ name: 'n1', addr: '/dns4/chat.example.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWx' } as any] }), 'https://chat.example.com/onchato/enroll')
  assert.equal(enrollUrl({ nodes: [{ name: 'x', addr: '/ip4/1.2.3.4/tcp/9001/ws/p2p/12D3KooWx' } as any] }), null)
})

test('a round trip through the node\'s own logic: not listed, a wrong code refused, the right one enrols, then listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enroll-c-'))
  try {
    const seed = Buffer.from('0123456789abcdefghij')
    writeFileSync(join(dir, 'totp.seed'), node.toBase32(seed))
    const e = node.makeEnroll({ networkId: 'acme', listFile: join(dir, 'peers.txt'), log: () => {} })
    const url = 'https://n1.example/onchato/enroll'
    const fake = (async (u: string, init?: any) => {
      const path = u.slice(url.length)
      const r = path === '/challenge' ? { status: 200, body: e.challenge() }
        : path === '/status' ? await e.status(JSON.parse(init.body))
        : await e.enroll(JSON.parse(init.body), '1.2.3.4')
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as any as typeof fetch
    const key = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    assert.deepEqual(await deviceStatus(url, 'acme', key, fake), { listed: false, locked: false })
    const bad = await enrollDevice(url, 'acme', key, '00000000', '', fake)
    assert.ok(!bad.ok && bad.error === 'code')
    const good = await enrollDevice(url, 'acme', key, node.totpAt(seed, Math.floor(Date.now() / 30000)), 'test', fake)
    assert.deepEqual(good, { ok: true })
    assert.deepEqual(await deviceStatus(url, 'acme', key, fake), { listed: true, locked: false })
    const wrongNet = await enrollDevice(url, 'other', key, node.totpAt(seed, Math.floor(Date.now() / 30000) + 1), '', fake)
    assert.ok(!wrongNet.ok && wrongNet.error === 'signature', 'a device signed for another network was accepted')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a sign-in round trip: the device starts it, the node redeems the code and lists the device', async () => {
  // @ts-ignore - plain .mjs
  const oidc = await import('../../relay/oidc.mjs')
  const { oidcBegin, enrollDeviceOidc, oidcNonce } = await import('../lib/enroll.ts')
  const { netPeerId } = await import('../lib/netkey.ts')
  const dir = mkdtempSync(join(tmpdir(), 'enroll-o-'))
  try {
    const key = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    // The device's nonce is the node's.
    assert.equal(await oidcNonce('acme', 'c1', netPeerId(key)), oidc.oidcNonce('acme', 'c1', netPeerId(key)))
    let askedNonce = ''
    const provider = { authorizeEndpoint: async () => 'https://idp.example/authorize', redeem: async ({ nonce }: any) => { if (nonce !== askedNonce) throw new Error('nonce'); return { sub: 'u1' } } }
    const e = node.makeEnroll({ networkId: 'acme', listFile: join(dir, 'peers.txt'), log: () => {}, oidc: { provider, clientId: 'c', redirectUri: 'https://app.example/oidc.html', scope: 'openid', allowDomain: '', allowGroup: '', record: 'none' } })
    const url = 'https://n1.example/onchato/enroll'
    const fake = (async (u: string, init?: any) => {
      const path = u.slice(url.length)
      const r = path.startsWith('/challenge') ? { status: 200, body: await e.challenge(path.includes('for=oidc') ? 'oidc' : '') }
        : path === '/status' ? await e.status(JSON.parse(init.body))
        : await e.enrollOidc(JSON.parse(init.body), '1.2.3.4')
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as any as typeof fetch
    await assert.rejects(oidcBegin(url, 'acme', key, 'https://other-idp.example', fake), /not the network's provider/)
    const go = await oidcBegin(url, 'acme', key, 'https://idp.example', fake)
    const q = new URL(go.authorizeUrl).searchParams
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('redirect_uri'), 'https://app.example/oidc.html')
    askedNonce = q.get('nonce')!
    assert.equal(askedNonce, oidc.oidcNonce('acme', go.challenge, netPeerId(key)))
    assert.deepEqual(await enrollDeviceOidc(url, 'acme', key, go.challenge, 'the-code', go.verifier, 'laptop', fake), { ok: true })
    assert.deepEqual(await deviceStatus(url, 'acme', key, fake), { listed: true, locked: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
