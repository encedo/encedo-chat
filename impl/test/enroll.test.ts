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
