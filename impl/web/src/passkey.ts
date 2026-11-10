/**
 * passkey.ts - the browser side of a software profile's unlock slot: WebAuthn
 * with the PRF extension (SPEC 4.5, Unlock slot; lib/unlockslot.ts).
 *
 * A passkey here is not a login to anything. Nothing is sent anywhere and no
 * server verifies an assertion: the passkey is asked for ONE thing, the output
 * of its PRF (CTAP2 hmac-secret) for a salt we keep, and those 32 bytes become
 * the key of the slot. The platform decides how the person proves it is them -
 * Touch ID, Face ID, Windows Hello, a phone's fingerprint, a security key's PIN -
 * and `userVerification: 'required'` is what makes it ask at all.
 *
 * The challenge is random and never checked, because there is no verifier: the
 * PRF output is the secret, and a passkey that is not the enrolled one, or one
 * that skipped verification, yields bytes the slot's AEAD refuses.
 *
 * Not offered in the packaged apps: their pages load from tauri://localhost or
 * http://tauri.localhost, which is no relying party a passkey can belong to.
 * Those get the platform's own keystore later (BIOMETRIA-PLAN, stage 6).
 */

import { randomBytes, b64, unb64 } from '../../lib/wc.ts'

/** The person closed the prompt, or it timed out: not an error to report. */
export class PasskeyCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'PasskeyCancelled' }
}
/** The browser or the passkey provider does not support PRF. */
export class PasskeyNoPrf extends Error {
  constructor() { super('no PRF'); this.name = 'PasskeyNoPrf' }
}
/** A device-bound passkey was asked for and a syncable one came back. */
export class PasskeySynced extends Error {
  constructor() { super('the passkey can be synced'); this.name = 'PasskeySynced' }
}

/**
 * Whether to show the option at all: a secure context, WebAuthn present, a
 * real web origin. PRF support itself is only known by trying (a browser may
 * claim it and the chosen provider still not have it), so this is a first cut
 * that `prfDeclaredMissing` can only narrow.
 */
export function passkeyPossible(): boolean {
  // Decided here rather than taken from app.ts: its `inAppShell` is declared far
  // below the sign-in code, and a read before that line is undefined, not an error.
  const inAppShell = !/^https?:$/.test(location.protocol) || location.hostname === 'tauri.localhost'
  return !inAppShell && typeof window !== 'undefined' && window.isSecureContext === true
    && typeof (window as any).PublicKeyCredential === 'function'
    && !!navigator.credentials?.create
}

/** True only when the browser says outright that it has no PRF. */
export async function prfDeclaredMissing(): Promise<boolean> {
  try {
    const caps = await (PublicKeyCredential as any).getClientCapabilities?.()
    return !!caps && caps['extension:prf'] === false
  } catch { return false }
}

const rpId = () => location.hostname

/** Authenticator data flags (WebAuthn 6.1): BE = backup eligible, i.e. the passkey can be synced. */
function backupEligible(authData: ArrayBuffer | undefined | null): boolean | null {
  if (!authData || authData.byteLength < 33) return null
  return (new Uint8Array(authData)[32] & 0x08) !== 0
}

function mapError(e: any): Error {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return new PasskeyCancelled()
  return e instanceof Error ? e : new Error(String(e))
}

function prfFirst(cred: any): Uint8Array | null {
  const r = cred?.getClientExtensionResults?.()?.prf?.results?.first
  if (!r) return null
  const u8 = new Uint8Array(r instanceof ArrayBuffer ? r : r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength))
  return u8.length === 32 ? u8 : null
}

async function assertPrf(credId: Uint8Array, salt: Uint8Array): Promise<{ secret: Uint8Array; be: boolean | null }> {
  let cred: any
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: rpId(),
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } } as any,
      },
    })
  } catch (e) { throw mapError(e) }
  if (!cred) throw new PasskeyCancelled()
  const secret = prfFirst(cred)
  if (!secret) throw new PasskeyNoPrf()
  return { secret, be: backupEligible(cred.response?.authenticatorData) }
}

/** Ask the provider to forget a passkey we will not use (best effort; Chrome 132+). */
function forget(credId: Uint8Array) {
  try {
    void (PublicKeyCredential as any).signalUnknownCredential?.({ rpId: rpId(), credentialId: b64url(credId) })?.catch?.(() => {})
  } catch {}
}
const b64url = (u8: Uint8Array) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export interface Enrolled { rpId: string; credId: string; prfSalt: string; synced: boolean; secret: Uint8Array }

/**
 * Make a passkey for this profile and get its PRF secret. `deviceOnly` asks
 * for a passkey that cannot be synced; the browser cannot be told to refuse a
 * syncable one, so the BE flag is checked afterwards and such a passkey is
 * refused (`PasskeySynced`).
 */
export async function enrollPasskey(name: string, deviceOnly: boolean): Promise<Enrolled> {
  const salt = randomBytes(32)
  let cred: any
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: rpId(), name: 'onchato' },
        user: { id: randomBytes(16), name, displayName: name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 120_000,
        // A hint, not a rule: the browser still offers whatever the person has.
        // Device-bound means a security key first: on macOS and iOS every
        // platform passkey lands in iCloud Keychain or Google Password Manager
        // and reports BE (Windows Hello is the platform that keeps one local).
        ...(deviceOnly ? { hints: ['security-key', 'client-device'] } : {}),
        extensions: { prf: { eval: { first: salt } } } as any,
      } as any,
    })
  } catch (e) { throw mapError(e) }
  if (!cred) throw new PasskeyCancelled()
  const credId = new Uint8Array(cred.rawId)
  const ext = cred.getClientExtensionResults?.()?.prf
  if (ext?.enabled === false) { forget(credId); throw new PasskeyNoPrf() }

  let secret = prfFirst(cred)
  let be = backupEligible(cred.response?.getAuthenticatorData?.())
  // Most providers give PRF only on an assertion, not at creation (Safari among
  // them): a second prompt, once, at enrolment.
  if (!secret) {
    const got = await assertPrf(credId, salt).catch((e) => { if (e instanceof PasskeyNoPrf) forget(credId); throw e })
    secret = got.secret
    be = got.be ?? be
  }
  // Unknown counts as syncable: the safe reading for a rule that refuses them.
  const synced = be !== false
  if (deviceOnly && synced) { forget(credId); secret.fill(0); throw new PasskeySynced() }
  return { rpId: rpId(), credId: b64(credId), prfSalt: b64(salt), synced, secret }
}

/** The PRF secret of an enrolled passkey, after the platform verified the person. */
export async function unlockPasskey(slot: { credId: string; prfSalt: string }): Promise<{ secret: Uint8Array; synced: boolean | null }> {
  const { secret, be } = await assertPrf(unb64(slot.credId), unb64(slot.prfSalt))
  return { secret, synced: be }
}
