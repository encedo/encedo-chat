import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, sign as nodeSign, constants } from 'node:crypto'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { verifyJws, checkClaims, makeProvider, oidcNonce, b64url } from './oidc.mjs'
import { makeEnroll, enrollMessage } from './enroll.mjs'
import { parseAllowlist } from './allowlist.mjs'

const ISS = 'https://idp.example'
const T0 = 1_800_000_000_000

function signer(alg) {
  const kp = alg === 'EdDSA' ? generateKeyPairSync('ed25519')
    : alg.startsWith('ES') ? generateKeyPairSync('ec', { namedCurve: { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[alg] })
      : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: `k-${alg}`, use: 'sig', alg }
  const hash = { EdDSA: null, ES256: 'sha256', ES384: 'sha384', ES512: 'sha512', RS256: 'sha256', PS256: 'sha256' }[alg]
  const jwt = (payload, header = {}) => {
    const h = b64url(JSON.stringify({ alg, typ: 'JWT', kid: jwk.kid, ...header })), p = b64url(JSON.stringify(payload))
    const opts = { key: kp.privateKey }
    if (alg.startsWith('ES')) opts.dsaEncoding = 'ieee-p1363'
    if (alg === 'PS256') { opts.padding = constants.RSA_PKCS1_PSS_PADDING; opts.saltLength = 32 }
    return `${h}.${p}.${b64url(nodeSign(hash, Buffer.from(`${h}.${p}`), opts))}`
  }
  return { jwk, jwt }
}
const claims = (over = {}) => ({ iss: ISS, aud: 'onchato-acme', sub: 'u-123', email: 'jan@acme.example', email_verified: true, iat: T0 / 1000, exp: T0 / 1000 + 300, nonce: 'n1', ...over })

test('a JWS verifies under every accepted algorithm, and a touched one does not', () => {
  for (const alg of ['EdDSA', 'ES256', 'ES384', 'ES512', 'RS256', 'PS256']) {
    const s = signer(alg)
    const jwt = s.jwt(claims())
    assert.equal(verifyJws(jwt, s.jwk).payload.sub, 'u-123', alg)
    const [h, p, sig] = jwt.split('.')
    const forged = `${h}.${b64url(JSON.stringify(claims({ sub: 'admin' })))}.${sig}`
    assert.throws(() => verifyJws(forged, s.jwk), /bad signature/, alg)
    assert.throws(() => verifyJws(jwt, signer(alg).jwk), /bad signature/, `${alg}: another key`)
  }
  const s = signer('ES256')
  const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims()))}.`
  assert.throws(() => verifyJws(none, s.jwk), /not accepted/)
  assert.throws(() => verifyJws(s.jwt(claims(), { alg: 'HS256' }), s.jwk), /not accepted/)
})

test('the claims: issuer, audience, time, nonce, domain, group', () => {
  const ok = { issuer: ISS, clientId: 'onchato-acme', nonce: 'n1', now: T0 }
  assert.equal(checkClaims(claims(), ok).sub, 'u-123')
  assert.throws(() => checkClaims(claims({ iss: 'https://evil.example' }), ok), /issuer/)
  assert.throws(() => checkClaims(claims({ aud: 'other-app' }), ok), /audience/)
  assert.throws(() => checkClaims(claims({ aud: ['onchato-acme', 'x'], azp: 'x' }), ok), /audience/)
  assert.equal(checkClaims(claims({ aud: ['onchato-acme', 'x'], azp: 'onchato-acme' }), ok).sub, 'u-123')
  assert.throws(() => checkClaims(claims({ exp: T0 / 1000 - 120 }), ok), /expired/)
  assert.throws(() => checkClaims(claims({ iat: T0 / 1000 + 600 }), ok), /future/)
  assert.throws(() => checkClaims(claims({ nonce: 'n2' }), ok), /nonce/)
  assert.equal(checkClaims(claims(), { ...ok, allowDomain: 'acme.example' }).sub, 'u-123')
  assert.throws(() => checkClaims(claims({ email: 'jan@evil.example' }), { ...ok, allowDomain: 'acme.example' }), /domain/)
  assert.throws(() => checkClaims(claims({ email_verified: false }), { ...ok, allowDomain: 'acme.example' }), /domain/)
  assert.throws(() => checkClaims(claims({ email: 'jan@notacme.example' }), { ...ok, allowDomain: 'acme.example' }), /domain/)
  assert.equal(checkClaims(claims({ email: undefined, hd: 'acme.example' }), { ...ok, allowDomain: 'acme.example' }).sub, 'u-123')
  assert.equal(checkClaims(claims({ groups: ['staff', 'chat'] }), { ...ok, allowGroup: 'chat' }).sub, 'u-123')
  assert.throws(() => checkClaims(claims({ groups: ['staff'] }), { ...ok, allowGroup: 'chat' }), /group/)
})

/** A provider in memory: discovery, keys, and a token endpoint that hands out what `issue` says. */
function fakeIdp(alg = 'ES256', { authMethods = ['client_secret_basic'] } = {}) {
  let s = signer(alg)
  const seen = []
  let issue = (_form) => ({ status: 200, body: { id_token: s.jwt(claims()) } })
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body })
    if (url === `${ISS}/.well-known/openid-configuration`) return json(200, { issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`, token_endpoint_auth_methods_supported: authMethods })
    if (url === `${ISS}/jwks`) return json(200, { keys: [s.jwk] })
    if (url === `${ISS}/token`) { const r = issue(new URLSearchParams(init.body), init.headers); return json(r.status, r.body) }
    return json(404, {})
  }
  return { fetchImpl, seen, set issue(f) { issue = f }, signer: () => s, rotate: () => { s = signer(alg) } }
}

async function oidcSetup({ record = 'none', allowDomain = '', alg = 'ES256' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enroll-oidc-')), listFile = join(dir, 'peers.txt')
  const idp = fakeIdp(alg)
  let t = T0
  const provider = makeProvider({ issuer: ISS, clientId: 'onchato-acme', clientSecret: 's3cret', fetchImpl: idp.fetchImpl, now: () => t })
  const e = makeEnroll({ networkId: 'acme', listFile, now: () => t, log: () => {}, oidc: { provider, clientId: 'onchato-acme', redirectUri: 'https://app.example/oidc.html', scope: 'openid', allowDomain, allowGroup: '', record } })
  const key = await generateKeyPair('Ed25519'), peerId = peerIdFromPrivateKey(key).toString()
  const attempt = async ({ k = key, id = peerId, ip = '1.2.3.4', code = 'auth-code-1', mint } = {}) => {
    const ch = await e.challenge('oidc')
    // The provider's token carries whatever nonce the device asked for: by default the honest one.
    idp.issue = (form) => ({ status: 200, body: { id_token: idp.signer().jwt(claims({ iat: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 300, nonce: mint ? mint(ch.nonce) : oidcNonce('acme', ch.nonce, id), code: form.get('code') })) } })
    const sig = Buffer.from(await k.sign(enrollMessage('acme', ch.nonce, 'oidc:' + code))).toString('base64')
    return { ch, r: await e.enrollOidc({ peerId: id, nonce: ch.nonce, code, verifier: 'v'.repeat(43), sig, label: 'laptop' }, ip) }
  }
  return { dir, listFile, e, idp, peerId, key, attempt, tick: (ms) => { t += ms } }
}

test('a sign-in at the provider puts the device on the list; the node redeems the code with its secret', async () => {
  for (const alg of ['EdDSA', 'ES256', 'RS256']) {
    const s = await oidcSetup({ alg })
    try {
      const { ch, r } = await s.attempt()
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(ch.authorize, `${ISS}/authorize`)
      assert.equal(ch.redirectUri, 'https://app.example/oidc.html')
      assert.ok(parseAllowlist(readFileSync(s.listFile, 'utf8')).ids.has(s.peerId))
      const tok = s.idp.seen.find((x) => x.url === `${ISS}/token`)
      const form = new URLSearchParams(tok.init.body)
      assert.equal(form.get('code'), 'auth-code-1'); assert.equal(form.get('code_verifier'), 'v'.repeat(43)); assert.equal(form.get('redirect_uri'), 'https://app.example/oidc.html')
      assert.equal(tok.init.headers.authorization, 'Basic ' + Buffer.from('onchato-acme:s3cret').toString('base64'))
      assert.equal(form.get('client_secret'), null, 'with basic auth the secret is not in the body')
      // Policy "none": nothing about the person on the list.
      assert.ok(!readFileSync(s.listFile, 'utf8').includes('u-123') && !readFileSync(s.listFile, 'utf8').includes('jan@'), 'policy none recorded the person')
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }
})

test('the token is bound to this challenge and this device', async () => {
  const s = await oidcSetup()
  try {
    // A token minted for another device's PeerId (the nonce of another enrolment) does not list this one.
    const other = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
    let r = (await s.attempt({ mint: (n) => oidcNonce('acme', n, other) })).r
    assert.equal(r.status, 403); assert.equal(r.body.why, 'nonce')
    // A token for an older challenge.
    r = (await s.attempt({ mint: () => oidcNonce('acme', 'an-old-challenge', s.peerId) })).r
    assert.equal(r.status, 403); assert.equal(r.body.why, 'nonce')
    assert.ok(!parseAllowlist(readFileSync(s.listFile, 'utf8').toString?.() ?? '').ids.has(s.peerId))
  } catch (e) { if (e.code !== 'ENOENT') throw e } finally { rmSync(s.dir, { recursive: true, force: true }) }
})

test('a signature by another key, a reused challenge, a refused code - and the policies that record the person', async () => {
  const s = await oidcSetup()
  try {
    const stranger = await generateKeyPair('Ed25519')
    let r = (await s.attempt({ k: stranger })).r
    assert.equal(r.status, 400); assert.equal(r.body.error, 'signature')
    const { ch } = await s.attempt()
    const sig = Buffer.from(await s.key.sign(enrollMessage('acme', ch.nonce, 'oidc:auth-code-1'))).toString('base64')
    r = await s.e.enrollOidc({ peerId: s.peerId, nonce: ch.nonce, code: 'auth-code-1', verifier: 'v'.repeat(43), sig }, '1.2.3.4')
    assert.equal(r.body.error, 'challenge', 'a challenge worked twice')
    s.idp.issue = () => ({ status: 400, body: { error: 'invalid_grant' } })
    const ch2 = await s.e.challenge('oidc')
    const sig2 = Buffer.from(await s.key.sign(enrollMessage('acme', ch2.nonce, 'oidc:bad'))).toString('base64')
    r = await s.e.enrollOidc({ peerId: s.peerId, nonce: ch2.nonce, code: 'bad', verifier: 'v'.repeat(43), sig: sig2 }, '9.9.9.9')
    assert.equal(r.status, 403); assert.match(r.body.why, /invalid_grant/)
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
  for (const [record, want] of [['sub', 'sub:u-123'], ['email', 'jan@acme.example']]) {
    const p = await oidcSetup({ record })
    try {
      assert.equal((await p.attempt()).r.status, 200)
      assert.ok(readFileSync(p.listFile, 'utf8').includes(want), `${record}: ${readFileSync(p.listFile, 'utf8')}`)
    } finally { rmSync(p.dir, { recursive: true, force: true }) }
  }
})

test('refused sign-ins slow an address down but never lock the network', async () => {
  const s = await oidcSetup({ allowDomain: 'other.example' })
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.attempt({ ip: '6.6.6.6' })).r.body.error, 'domain')
    assert.equal((await s.attempt({ ip: '6.6.6.6' })).r.status, 429)
    s.tick(11 * 60_000)
    assert.equal((await s.attempt({ ip: '6.6.6.6' })).r.body.error, 'domain', 'the address was let go after 10 minutes')
    for (let i = 0; i < 25; i++) await s.attempt({ ip: `10.0.0.${i}` })
    assert.notEqual((await s.attempt({ ip: '10.9.9.9' })).r.status, 423, 'refused sign-ins locked the network')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
})

test('a rotated provider key is fetched again; an unknown issuer in discovery is refused', async () => {
  const s = await oidcSetup()
  try {
    assert.equal((await s.attempt()).r.status, 200)
    s.idp.rotate()
    s.tick(61_000) // a token naming an unknown key fetches the keys again - at most once a minute
    const k2 = await generateKeyPair('Ed25519')
    assert.equal((await s.attempt({ k: k2, id: peerIdFromPrivateKey(k2).toString() })).r.status, 200, 'a new key at the provider was not picked up')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
  const bad = makeProvider({ issuer: 'https://other.example', clientId: 'c', clientSecret: 's', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: ISS }) }) })
  await assert.rejects(bad.authorizeEndpoint(), /issuer/)
})
