/**
 * identity.ts — Identity factories for the CLIs (node-only backends):
 *   - hemIdentity: key in the HEM (real product), login-or-register, ECDH on device.
 *   - softwareIdentity: key in a local keystore file (dev/test), ECDH via node X25519.
 * The Identity interface + the browser-safe HEM constructor live in lib/core.ts.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { diffieHellman } from 'node:crypto'
import { Keystore, rawToPriv, rawToPub } from './keystore.ts'
import { hemIdentityFrom, type Identity } from '../lib/core.ts'
import { SELF_PREFIX, buildSelfDescr, parseSelfDescr, selfLabel } from '../lib/descr.ts'

export type { Identity }

/**
 * HEM-backed identity: signs in as an existing `ETSEIC:self1` key, else registers one.
 *
 * A device may now hold several (§4 Proposal), and a CLI has no picker — so
 * `handleHint` selects, matched case-insensitively, and only an unambiguous
 * device signs in without one. Guessing here would mean running as the wrong
 * identity, which looks like an empty contact book rather than like an error.
 */
export async function hemIdentity(url: string, password: string, handleHint?: string): Promise<Identity> {
  return (await hemSignIn(url, password, handleHint)).id
}

/** The same sign-in, also handing back the device and the KID - the contact book
 *  in the HEM (lib/core.ts hemContactBook) needs both. */
export interface HemChoice { kid: string; handle: string }

/**
 * `handleHint` selects by name; without it, one identity signs in at once and
 * several go to `choose` (the CLI asks "1, 2 or 3?" on a terminal), sorted by
 * handle the way the app's sign-in picker shows them. With no `choose` - a
 * script, the daemon - several identities are an error that lists them, never
 * a guess: running as the wrong identity looks like an empty contact book.
 */
export async function hemSignIn(
  url: string, password: string, handleHint?: string,
  choose?: (ids: HemChoice[]) => Promise<HemChoice | null>,
): Promise<{ id: Identity; hem: any; kid: string }> {
  const hem = new HEM(url)
  await hem.hemCheckin()
  const listTok = await hem.authorizePassword(password, 'keymgmt:list')
  const keys: any[] = await hem.searchKeys(listTok, SELF_PREFIX)
  const ids: HemChoice[] = keys.map((k) => ({ kid: String(k.kid), handle: parseSelfDescr(k.description)?.handle || '(?)' }))
  const chosen = await selectIdentity(ids, handleHint, choose)
  let kid: string, handle: string
  if (chosen) {
    kid = chosen.kid; handle = chosen.handle
  } else {
    handle = handleHint ?? 'me'
    const gen = await hem.authorizePassword(password, 'keymgmt:gen')
    const descrB64 = Buffer.from(buildSelfDescr(handle), 'utf8').toString('base64')
    kid = (await hem.createKeyPair(gen, selfLabel(handle), 'CURVE25519', descrB64)).kid
  }
  const useTok = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
  const { pubkey } = await hem.getPubKey(useTok, kid)
  return { id: hemIdentityFrom(hem, kid, handle, pubkey), hem, kid }
}

/**
 * Which HEM identity to sign in as (see hemSignIn). Null means "none here":
 * the caller then creates one. Throws rather than guessing.
 */
export async function selectIdentity(
  raw: HemChoice[], handleHint?: string, choose?: (ids: HemChoice[]) => Promise<HemChoice | null>,
): Promise<HemChoice | null> {
  const ids = raw.slice().sort((a, b) => a.handle.localeCompare(b.handle) || a.kid.localeCompare(b.kid))
  const pick = async (from: HemChoice[], why: string): Promise<HemChoice> => {
    if (!choose) throw new Error(`${why}: ${from.map((i) => `${i.handle} (${i.kid.slice(0, 8)})`).join(', ')} - name one with --handle`)
    const c = await choose(from)
    if (!c) throw new Error('no identity chosen')
    return c
  }
  const named = handleHint ? ids.filter((i) => i.handle.toLowerCase() === handleHint.toLowerCase()) : []
  if (named.length > 1) return pick(named, `several identities are called "${handleHint}"`)
  if (named.length === 1) return named[0]
  if (handleHint && ids.length) throw new Error(`no identity called "${handleHint}" here: ${ids.map((i) => i.handle).join(', ')}`)
  if (ids.length === 1) return ids[0]
  if (ids.length > 1) return pick(ids, `this HEM holds ${ids.length} identities`)
  return null
}

/** Software identity (dev/test). Creates the keystore if missing. */
export function softwareIdentity(storePath: string, handleHint = 'me'): Identity {
  const ks = Keystore.exists(storePath) ? Keystore.load(storePath) : Keystore.create(storePath, handleHint)
  return {
    handle: ks.data.handle,
    pub: ks.data.pub,
    async ecdh(peerPubB64: string) {
      return new Uint8Array(diffieHellman({
        privateKey: rawToPriv(new Uint8Array(Buffer.from(ks.data.priv, 'base64'))),
        publicKey: rawToPub(new Uint8Array(Buffer.from(peerPubB64, 'base64'))),
      }))
    },
  }
}
