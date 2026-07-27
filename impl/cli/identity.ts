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

export type { Identity }

const dec = new TextDecoder()
const parseHandle = (d: Uint8Array | null) => (d ? dec.decode(d).split('\0')[0].split(',')[1] : undefined) ?? '(?)'

/** HEM-backed identity. Logs in if an ETSEIC:self key exists, else registers one. */
export async function hemIdentity(url: string, password: string, handleHint = 'me'): Promise<Identity> {
  const hem = new HEM(url)
  await hem.hemCheckin()
  const listTok = await hem.authorizePassword(password, 'keymgmt:list')
  const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:self,')

  let kid: string, handle: string
  if (keys.length) {
    kid = keys[0].kid; handle = parseHandle(keys[0].description)
  } else {
    handle = handleHint
    const gen = await hem.authorizePassword(password, 'keymgmt:gen')
    const iat = Math.floor(Date.now() / 1000)
    const descrB64 = Buffer.from(`ETSEIC:self,${handle},ik,${iat}`, 'utf8').toString('base64')
    kid = (await hem.createKeyPair(gen, `chat-ik-${handle}`, 'CURVE25519', descrB64)).kid
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
