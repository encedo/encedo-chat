/**
 * identity.ts — one identity abstraction for the `ec` CLI, two backends:
 *   - hemIdentity: key in the HEM (real product), ECDH on the device.
 *   - softwareIdentity: key in a local file (dev/test), ECDH via node X25519.
 * Both expose { handle, pub, ecdh(peerPubB64) }.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { diffieHellman } from 'node:crypto'
import { Keystore, rawToPriv, rawToPub } from '../bob/keystore.ts'

export interface Identity {
  handle: string
  pub: string                                        // base64
  ecdh(peerPubB64: string): Promise<Uint8Array>      // raw 32-byte shared secret
}

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

  return {
    handle,
    pub: pubkey,
    async ecdh(peerPubB64: string) {
      const t = await hem.authorizePassword(null, `keymgmt:use:${kid}`)   // cached derived key → no re-prompt
      return hem.ecdh(t, kid, peerPubB64)
    },
  }
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
