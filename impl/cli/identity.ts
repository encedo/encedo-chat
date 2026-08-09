/**
 * identity.ts — Identity factories for the CLIs (node-only backends):
 *   - hemIdentity: key in the HEM (real product), login-or-register, ECDH on device.
 *   - softwareIdentity: key in a local keystore file (dev/test), ECDH via node X25519.
 * The Identity interface + the browser-safe HEM constructor live in lib/core.ts.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { diffieHellman } from 'node:crypto'
import { Keystore, rawToPriv, rawToPub } from '../bob/keystore.ts'
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
export async function hemIdentity(url: string, password: string, handleHint = 'me'): Promise<Identity> {
  const hem = new HEM(url)
  await hem.hemCheckin()
  const listTok = await hem.authorizePassword(password, 'keymgmt:list')
  const keys: any[] = await hem.searchKeys(listTok, SELF_PREFIX)
  const ids = keys.map((k) => ({ kid: String(k.kid), handle: parseSelfDescr(k.description)?.handle || '(?)' }))

  let kid: string, handle: string
  const named = ids.filter((i) => i.handle.toLowerCase() === handleHint.toLowerCase())
  if (named.length > 1) {
    throw new Error(`several identities are called "${handleHint}": ${named.map((i) => i.kid.slice(0, 8)).join(', ')}`)
  } else if (named.length === 1) {
    kid = named[0].kid; handle = named[0].handle
  } else if (ids.length === 1) {
    kid = ids[0].kid; handle = ids[0].handle
  } else if (ids.length > 1) {
    throw new Error(`this HEM holds ${ids.length} identities (${ids.map((i) => i.handle).join(', ')}) — name one with --handle`)
  } else {
    handle = handleHint
    const gen = await hem.authorizePassword(password, 'keymgmt:gen')
    const descrB64 = Buffer.from(buildSelfDescr(handle), 'utf8').toString('base64')
    kid = (await hem.createKeyPair(gen, selfLabel(handle), 'CURVE25519', descrB64)).kid
  }
  const useTok = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
  const { pubkey } = await hem.getPubKey(useTok, kid)
  return hemIdentityFrom(hem, kid, handle, pubkey)
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
