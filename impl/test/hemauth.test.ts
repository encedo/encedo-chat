/**
 * Where a HEM token comes from (`lib/hemauth.ts`): the password signs any scope
 * silently, the phone is asked only when the person is doing something - and
 * a background call never makes a phone buzz.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HemAuth, token, canSilently, renewStep, jwtClaims, HemReauthNeeded, HemScopeRefused } from '../lib/hemauth.ts'
import { hemContactBook, hemGkBackend, pubKeyReader, hemWarmTokens } from '../lib/core.ts'

const b64url = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: any) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`

/** A HEM whose phone approves (or trims) whatever it is asked. */
class FakeHem {
  pushes: Array<{ scope: any; ctx: string; note: string; signal: AbortSignal }> = []
  passwordAsks: any[] = []
  grant: (want: string[]) => string[] = (w) => w
  life = 600
  now = 1_800_000_000
  hold: Promise<void> | null = null
  async authorizePassword(_p: any, scope: any) { this.passwordAsks.push(scope); return 'pw-token' }
  async authorizeRemote(scope: any, o: any) {
    this.pushes.push({ scope, ctx: o.ctx, note: o.note, signal: o.signal })
    if (this.hold) await this.hold
    if (o.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' })
    const want = Array.isArray(scope) ? scope : [scope]
    const g = this.grant(want)
    return jwt({ scope: g.length === 1 ? g[0] : g, iat: this.now, exp: this.now + this.life, sub: 'x' })
  }
  imports: string[] = []
  async importPublicKey(_t: string, label: string) { this.imports.push(label); return { kid: 'beef' } }
  searchKeysAll() { return (async function* () {})() }
  async getKeyPublicInfo(_t: string, kid: string) { return { pubkey: new Uint8Array(32).fill(kid.length) } }
}
const remote = (h: FakeHem, extra: any = {}) => new HemAuth(h, { mode: 'remote', now: () => h.now * 1000, ...extra })

test('without a HemAuth, token() is the old authorizePassword(null, scope)', async () => {
  const h = new FakeHem()
  assert.equal(await token(h, 'keymgmt:list'), 'pw-token')
  assert.deepEqual(h.passwordAsks, ['keymgmt:list'])
  assert.equal(h.pushes.length, 0)
})

test('a password session never pushes, reason or not', async () => {
  const h = new FakeHem()
  new HemAuth(h, { mode: 'password' })
  await token(h, 'keymgmt:imp', { kind: 'contact-add', detail: 'bob' })
  await token(h, 'keymgmt:use:aa')
  assert.deepEqual(h.passwordAsks, ['keymgmt:imp', 'keymgmt:use:aa'])
  assert.equal(h.pushes.length, 0)
  assert.equal(canSilently(h, 'keymgmt:del'), true)
})

test('phone: a background call without a token fails and asks for re-auth, it does not push', async () => {
  const h = new FakeHem()
  let reauth = 0
  remote(h, { onReauth: () => reauth++ })
  await assert.rejects(token(h, 'keymgmt:list'), (e: any) => e instanceof HemReauthNeeded && e.code === 'hem_reauth')
  assert.equal(h.pushes.length, 0)
  assert.equal(reauth, 1)
})

test('phone: one sign-in push serves every session scope after it', async () => {
  const h = new FakeHem()
  const a = remote(h)
  const t = await token(h, ['keymgmt:list', 'keymgmt:use:aa'], { kind: 'login' })
  assert.equal(await token(h, 'keymgmt:list'), t)
  assert.equal(await token(h, 'keymgmt:use:aa'), t)
  assert.equal(h.pushes.length, 1)
  assert.deepEqual(a.sessionWindow(), { iat: h.now, exp: h.now + 600 })
  assert.deepEqual(a.sessionScopes().sort(), ['keymgmt:list', 'keymgmt:use:aa'])
  // ...and not a scope it was not given
  await assert.rejects(token(h, 'keymgmt:imp'), HemReauthNeeded)
})

test('phone: an action asks with its reason, the UI is told, and the token is kept', async () => {
  const h = new FakeHem()
  const seen: any[] = []; let settled = 0
  remote(h, { onAsk: (p: any) => seen.push(p), onSettle: () => settled++, note: (w: any) => `onchato: ${w.kind} ${w.detail}` })
  await token(h, 'keymgmt:imp', { kind: 'contact-add', detail: 'bob' })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].why, { kind: 'contact-add', detail: 'bob' })
  assert.deepEqual(seen[0].scope, ['keymgmt:imp'])
  assert.equal(h.pushes[0].note, 'onchato: contact-add bob')
  assert.equal(settled, 1)
  await token(h, 'keymgmt:imp', { kind: 'contact-add', detail: 'eve' })
  assert.equal(h.pushes.length, 1, 'a held action token is reused while it lives')
  // An action token is not a session token: the expiry bar does not follow it.
  const a = new HemAuth(new FakeHem(), { mode: 'remote' })
  assert.equal(a.sessionWindow(), null)
})

test('phone: the note is cut to the 128 characters the device accepts', async () => {
  const h = new FakeHem()
  remote(h)
  await token(h, 'keymgmt:imp', { kind: 'contact-add', detail: 'x'.repeat(300) })
  assert.equal(h.pushes[0].note.length, 128)
})

test('phone: a partial grant is refused for what is missing, the rest is usable', async () => {
  const h = new FakeHem()
  h.grant = (w) => w.filter((s) => s !== 'keymgmt:get')
  remote(h)
  await assert.rejects(token(h, ['keymgmt:list', 'keymgmt:get'], { kind: 'login' }),
    (e: any) => e instanceof HemScopeRefused && /keymgmt:get/.test(e.message))
  assert.equal(await token(h, 'keymgmt:list'), (await token(h, 'keymgmt:list')))
  assert.equal(h.pushes.length, 1)
  assert.equal(canSilently(h, 'keymgmt:get'), false)
})

test('phone: two callers wanting the same scope share one push', async () => {
  const h = new FakeHem()
  let release!: () => void
  h.hold = new Promise((r) => { release = r })
  remote(h)
  const p1 = token(h, 'keymgmt:del', { kind: 'contact-del', detail: 'bob' })
  const p2 = token(h, 'keymgmt:del', { kind: 'contact-del', detail: 'bob' })
  release()
  assert.equal(await p1, await p2)
  assert.equal(h.pushes.length, 1)
})

test('phone: cancel aborts the push the SDK is polling', async () => {
  const h = new FakeHem()
  let release!: () => void
  h.hold = new Promise((r) => { release = r })
  let settled = 0
  remote(h, { onAsk: (p: any) => p.cancel(), onSettle: () => settled++ })
  const p = token(h, 'keymgmt:gen', { kind: 'group-create' })
  release()
  await assert.rejects(p, (e: any) => e.code === 'aborted')
  assert.equal(h.pushes[0].signal.aborted, true)
  assert.equal(settled, 1)
})

test('phone: a renewal reaches the phone while the old token still lives, with a fresh ctx', async () => {
  const h = new FakeHem()
  const a = remote(h)
  await token(h, ['keymgmt:list', 'keymgmt:use:aa'], { kind: 'login' })
  h.now += 500 // 83% of 600 s
  await a.renew()
  assert.equal(h.pushes.length, 2)
  assert.notEqual(h.pushes[0].ctx, h.pushes[1].ctx)
  assert.deepEqual([...h.pushes[1].scope].sort(), ['keymgmt:list', 'keymgmt:use:aa'])
  assert.deepEqual(a.sessionWindow(), { iat: h.now, exp: h.now + 600 })
  // past the first token's end, the renewed one still answers
  h.now += 200
  await token(h, 'keymgmt:list')
  assert.equal(h.pushes.length, 2)
})

test('phone: a token in its last seconds is not handed out', async () => {
  const h = new FakeHem()
  remote(h)
  await token(h, 'keymgmt:list', { kind: 'login' })
  h.now += 597
  await assert.rejects(token(h, 'keymgmt:list'), HemReauthNeeded)
})

test('renewStep: the bar steps at 80, 85, 90, 95 % and at expiry', () => {
  const w = { iat: 1000, exp: 2000 }
  const at = (f: number) => renewStep(w, 1000 + f * 1000)
  assert.deepEqual([0, 0.79, 0.8, 0.849, 0.85, 0.9, 0.95, 0.999, 1, 1.5].map(at), [0, 0, 1, 1, 2, 3, 4, 4, 5, 5])
  assert.equal(renewStep(null, 5000), 0)
  assert.equal(renewStep({ iat: 5, exp: 5 }, 5), 0)
})

test('jwtClaims reads a base64url payload and survives garbage', () => {
  assert.deepEqual(jwtClaims(jwt({ scope: ['a', 'b'], exp: 3 })), { scope: ['a', 'b'], exp: 3 })
  assert.equal(jwtClaims('nope'), null)
})

// ---- the engine asks with the right reasons ----------------------------------

const OWNER = '00112233445566778899aabbccddeeff'

test('engine, phone: adding a contact asks the phone with the contact name', async () => {
  const h = new FakeHem()
  remote(h)
  await token(h, ['keymgmt:list', `keymgmt:use:${OWNER}`], { kind: 'login' })
  await hemContactBook(h, OWNER).add('bob', Buffer.alloc(32, 7).toString('base64'))
  assert.equal(h.pushes.length, 2)
  assert.equal(h.pushes[1].scope, 'keymgmt:imp')
  assert.match(h.pushes[1].note, /contact-add bob/)
  assert.deepEqual(h.imports.length, 1)
})

test('engine, phone: joining a group as a member never pushes for the portable record', async () => {
  const h = new FakeHem()
  remote(h)
  await token(h, ['keymgmt:list', `keymgmt:use:${OWNER}`], { kind: 'login' })
  await assert.rejects(hemGkBackend(h).importPub!(new Uint8Array(32), 'g', 'd'), HemReauthNeeded)
  assert.equal(h.pushes.length, 1)
  assert.equal(h.imports.length, 0)
})

test('engine, phone: the own key is read with the sign-in scope, not a new push for keymgmt:get', async () => {
  const h = new FakeHem()
  remote(h)
  await token(h, ['keymgmt:list', `keymgmt:use:${OWNER}`], { kind: 'login' })
  await pubKeyReader(h)(OWNER)
  await hemWarmTokens(h, OWNER)
  assert.equal(h.pushes.length, 1)
  assert.equal(h.passwordAsks.length, 0)
})

test('engine, password: the same calls never reach the phone (negative of the above)', async () => {
  const h = new FakeHem()
  new HemAuth(h, { mode: 'password' })
  await hemContactBook(h, OWNER).add('bob', Buffer.alloc(32, 7).toString('base64'))
  await pubKeyReader(h)(OWNER)
  assert.equal(h.pushes.length, 0)
  assert.ok(h.passwordAsks.includes('keymgmt:imp'))
  assert.ok(h.passwordAsks.includes('keymgmt:get'))
})
