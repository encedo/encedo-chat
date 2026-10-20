/**
 * oidc.mjs - a device admitted by its owner's sign-in at the company's identity
 * provider instead of the administrator's TOTP code (access tier B, the
 * company variant; enroll.mjs drives it).
 *
 * The node is the OIDC client - a CONFIDENTIAL one: the device sends the
 * authorization code it got back, the node exchanges it at the provider's token
 * endpoint with the client secret (which never leaves the node), and checks the
 * id_token that comes back: signature against the provider's published keys,
 * issuer, audience, time, and the nonce - which binds the sign-in to ONE
 * enrolment challenge and ONE device (oidcNonce below), so a token cannot put a
 * second device on the list.
 *
 * No dependencies: discovery and keys by fetch, signatures by node:crypto
 * (EdDSA, ES256/384/512, RS256/384/512, PS256/384/512). Code is ASCII (repo rule).
 */
import { createHash, createPublicKey, verify, constants } from 'node:crypto'

const b64u = (s) => Buffer.from(s, 'base64url')
export const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** The nonce the device puts in the sign-in request, recomputed here from the challenge and its PeerId. */
export const oidcNonce = (networkId, challengeNonce, peerId) =>
  b64url(createHash('sha256').update(`onchato-oidc-v1\n${networkId}\n${challengeNonce}\n${peerId}`).digest())

const ALGS = {
  EdDSA: { hash: null },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: 32 }, PS384: { hash: 'sha384', pss: 48 }, PS512: { hash: 'sha512', pss: 64 },
}

/** Verify a compact JWS against one JWK; the payload object, or throws. */
export function verifyJws(jwt, jwk) {
  const parts = String(jwt).split('.')
  if (parts.length !== 3) throw new Error('not a JWT')
  const header = JSON.parse(b64u(parts[0]).toString('utf8'))
  const a = ALGS[header.alg]
  if (!a) throw new Error(`algorithm not accepted: ${header.alg}`)
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${parts[0]}.${parts[1]}`)
  const sig = b64u(parts[2])
  const opts = { key }
  if (a.ec) opts.dsaEncoding = 'ieee-p1363'
  if (a.pss) { opts.padding = constants.RSA_PKCS1_PSS_PADDING; opts.saltLength = a.pss }
  if (!verify(a.hash, data, opts, sig)) throw new Error('bad signature')
  return { header, payload: JSON.parse(b64u(parts[1]).toString('utf8')) }
}

/**
 * The claims a node accepts. `allowDomain`: the e-mail's domain (a verified
 * e-mail) or Google's `hd`; `allowGroup`: a value in `groups`. Returns the
 * payload, or throws with the reason.
 */
export function checkClaims(p, { issuer, clientId, nonce, now = Date.now(), allowDomain = '', allowGroup = '' }) {
  const t = Math.floor(now / 1000)
  if (p.iss !== issuer) throw new Error('issuer')
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud]
  if (!aud.includes(clientId)) throw new Error('audience')
  if (aud.length > 1 && p.azp !== undefined && p.azp !== clientId) throw new Error('audience')
  if (typeof p.exp !== 'number' || p.exp < t - 60) throw new Error('expired')
  if (typeof p.iat === 'number' && p.iat > t + 300) throw new Error('issued in the future')
  if (p.nonce !== nonce) throw new Error('nonce')
  if (allowDomain) {
    const email = typeof p.email === 'string' ? p.email.toLowerCase() : ''
    const byMail = email.endsWith('@' + allowDomain.toLowerCase()) && p.email_verified !== false
    if (!byMail && p.hd !== allowDomain) throw new Error('domain')
  }
  if (allowGroup && !(Array.isArray(p.groups) && p.groups.includes(allowGroup))) throw new Error('group')
  return p
}

/**
 * A provider: discovery and keys cached (an hour), keys fetched again when a
 * token names one we do not have - at most once a minute.
 */
export function makeProvider({ issuer, clientId, clientSecret, fetchImpl = fetch, now = () => Date.now() }) {
  let meta = null, metaAt = 0, keys = null, keysAt = 0
  const base = issuer.replace(/\/+$/, '')
  async function discovery() {
    if (meta && now() - metaAt < 3_600_000) return meta
    const r = await fetchImpl(`${base}/.well-known/openid-configuration`)
    if (!r.ok) throw new Error(`discovery: HTTP ${r.status}`)
    const m = await r.json()
    if (m.issuer !== issuer) throw new Error(`discovery: the issuer is ${m.issuer}, not ${issuer}`)
    meta = m; metaAt = now(); return m
  }
  async function jwks(force = false) {
    if (keys && !force && now() - keysAt < 3_600_000) return keys
    if (keys && force && now() - keysAt < 60_000) return keys
    const r = await fetchImpl((await discovery()).jwks_uri)
    if (!r.ok) throw new Error(`keys: HTTP ${r.status}`)
    keys = (await r.json()).keys ?? []; keysAt = now(); return keys
  }
  const pick = (ks, header) => ks.filter((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === 'sig'))
  /** The payload, under one of the provider's keys; the keys fetched again once when none fits (a rotation, even one that kept the kid). */
  async function verified(jwt, header) {
    let last = null
    for (const fresh of [false, true]) {
      for (const k of pick(await jwks(fresh), header)) { try { return verifyJws(jwt, k).payload } catch (e) { last = e } }
    }
    throw last ?? new Error('no key for this token')
  }
  return {
    async authorizeEndpoint() { return (await discovery()).authorization_endpoint },
    /** Exchange the device's code; the id_token's checked payload. */
    async redeem({ code, codeVerifier, redirectUri, nonce, allowDomain, allowGroup }) {
      const m = await discovery()
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: clientId })
      const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
      const methods = m.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
      if (methods.includes('client_secret_basic')) headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')
      else form.set('client_secret', clientSecret)
      const r = await fetchImpl(m.token_endpoint, { method: 'POST', headers, body: form.toString() })
      const body = await r.json().catch(() => ({}))
      if (!r.ok || typeof body.id_token !== 'string') throw new Error(`token: ${body.error ?? 'HTTP ' + r.status}${body.error_description ? ' - ' + body.error_description : ''}`)
      const header = JSON.parse(b64u(body.id_token.split('.')[0]).toString('utf8'))
      const payload = await verified(body.id_token, header)
      return checkClaims(payload, { issuer, clientId, nonce, now: now(), allowDomain, allowGroup })
    },
  }
}
