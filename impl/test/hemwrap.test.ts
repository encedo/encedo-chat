/**
 * The two layers over a HEM (`lib/hemwrap.ts`) — and the bug that put them in a
 * file a test can reach.
 *
 * Composed as `traceHem(cachePubKeys(hem))` the app died on the first call with
 * *"can't access private field or method: object is not the right class"*: the
 * inner proxy handed back an UNBOUND method, the outer one applied it with the
 * proxy as `this`, and `#private` fields are not reachable that way. The SDK is
 * built almost entirely out of them, so this broke sign-in completely — and no
 * test could see it, because both wrappers lived in the browser entry point.
 *
 * So the first test here is a class with a private field, wrapped both ways
 * round and in both orders.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachePubKeys, traceHem } from '../lib/hemwrap.ts'

/** Stands in for the SDK: its state is private, exactly as `HEM`'s is. */
class Fake {
  #secret: string
  calls: string[] = []
  pubKeyCalls = 0
  constructor(secret: string) { this.#secret = secret }
  async hemCheckin() { this.calls.push('hemCheckin'); return this.#secret }
  async getPubKey(_token: string, kid: string) { this.pubKeyCalls++; return { pubkey: `${this.#secret}:${kid}` } }
  async searchKeys(_token: string, pattern: string) { this.calls.push(`search ${pattern}`); return [{ kid: 'K1' }] }
  notAnApiCall() { return this.#secret } // nothing in CALLS describes it
}
const quiet = () => {}

test('a wrapped method still runs as the object it belongs to, in any composition', async () => {
  for (const [name, make] of [
    ['trace(cache(hem))', (h: any) => traceHem(cachePubKeys(h), quiet)],
    ['cache(trace(hem))', (h: any) => cachePubKeys(traceHem(h, quiet))],
    ['cache alone', (h: any) => cachePubKeys(h)],
    ['trace alone', (h: any) => traceHem(h, quiet)],
    ['trace(trace(cache(hem)))', (h: any) => traceHem(traceHem(cachePubKeys(h), quiet), quiet)],
  ] as [string, (h: any) => any][]) {
    const w = make(new Fake('S'))
    assert.equal(await w.hemCheckin(), 'S', name)
    assert.equal((await w.getPubKey('t', 'K')).pubkey, 'S:K', name)
    // A method the tracer has no description for must survive too — it is
    // handed straight through, and that is the path that was unbound.
    assert.equal(w.notAnApiCall(), 'S', name)
  }
})

test('a public key is fetched once per KID, and concurrent callers share the call', async () => {
  const hem = new Fake('S')
  const w = cachePubKeys(hem)
  const [a, b] = await Promise.all([w.getPubKey('t', 'K1'), w.getPubKey('t', 'K1')])
  const c = await w.getPubKey('t', 'K1')
  assert.equal(hem.pubKeyCalls, 1, 'one device call for one KID')
  assert.equal(a.pubkey, 'S:K1'); assert.equal(b.pubkey, c.pubkey)
  await w.getPubKey('t', 'K2')
  assert.equal(hem.pubKeyCalls, 2, 'a different KID is a different key')
  // Case does not make a different key: a KID is hex either way.
  await w.getPubKey('t', 'k1')
  assert.equal(hem.pubKeyCalls, 2)
})

test('a failed fetch is not remembered as an answer', async () => {
  let n = 0
  const flaky = { async getPubKey() { n++; if (n === 1) throw new Error('device asleep'); return { pubkey: 'P' } } }
  const w = cachePubKeys(flaky)
  await assert.rejects(() => w.getPubKey('t', 'K'))
  assert.equal((await w.getPubKey('t', 'K')).pubkey, 'P', 'the second attempt reaches the device')
  assert.equal(n, 2)
})

test('the trace says what was asked, and never a token or a password', async () => {
  const lines: string[] = []
  const hem = {
    async authorizePassword(_pw: string, _scope: string) { return 'TOKEN-SENTINEL' },
    async searchKeys(_t: string, p: string) { return [p] },
  }
  const w = traceHem(hem, (m) => lines.push(m))
  await w.authorizePassword('PASSWORD-SENTINEL', 'keymgmt:list')
  await w.searchKeys('TOKEN-SENTINEL', 'ETSEIC:self1,')
  assert.ok(lines.some((l) => l === 'Req access token for scope keymgmt:list'))
  assert.ok(lines.some((l) => l === 'Req key search "ETSEIC:self1,"'))
  assert.equal(lines.filter((l) => l.includes('SENTINEL')).length, 0, 'no secret reaches the log')
})

test('an answer that never left the machine is marked as such', async () => {
  const kinds: string[] = []
  const hem = { async getPubKey(_t: string, _k: string) { return { pubkey: 'P' } } }
  // Cache under trace: the second call is answered locally, and a reader of the
  // trace has to be able to tell that from device traffic.
  const w = traceHem(cachePubKeys(hem), (_m, kind) => kinds.push(kind))
  await w.getPubKey('t', 'K')
  await w.getPubKey('t', 'K')
  assert.equal(kinds.filter((k) => k === 'cached').length, 2, 'both were instant here — the point is they are labelled')
  assert.equal(kinds.filter((k) => k === 'req').length, 2)
})

test('a failure is reported with the code the transport gave it', async () => {
  const lines: string[] = []
  const hem = { async getStatus() { throw Object.assign(new Error('gone'), { code: 'timeout' }) } }
  await assert.rejects(() => traceHem(hem, (m) => lines.push(m)).getStatus())
  assert.ok(lines.some((l) => l.startsWith('✗ device status — timeout:')), lines.join(' | '))
})
