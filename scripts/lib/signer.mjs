/**
 * signer.mjs - one Ed25519 root key, wherever it lives, behind one interface:
 * `pub()` (base64, 32 bytes) and `sign(bytes)` (base64, 64 bytes, pure Ed25519
 * over exactly those bytes). Used by onchato-ops.mjs for operator network
 * profiles; the release scripts call yubikey-sign.mjs the same way.
 *
 *   --sign-yubikey [--slot 9c] [--module <libykcs11>]   PIN + touch per signature
 *   --sign <keyfile>                                    base64 private key, last
 *                                                       non-blank line (the format
 *                                                       release-manifest.mjs reads)
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { signFileYubikey, publicKeyYubikey, yubikeyPreflight } from '../yubikey-sign.mjs'

const b64e = (u) => Buffer.from(u).toString('base64')
const b64d = (s) => new Uint8Array(Buffer.from(s.trim(), 'base64'))
// node:crypto, not @noble: scripts/ has no node_modules of its own. A raw
// 32-byte Ed25519 seed becomes a key object through its fixed PKCS#8 header.
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const keyOf = (priv) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(b64d(priv))]), format: 'der', type: 'pkcs8' })
const pubOf = (key) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64')

/** The private key in a key file: the last line with no whitespace in it. */
export function readKeyFile(path) {
  const priv = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l)).pop()
  if (!priv || b64d(priv).length !== 32) throw new Error(`${path} holds no 32-byte base64 Ed25519 private key`)
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) console.error(`WARNING: ${path} is readable by others (chmod 600)`)
  return priv
}

/** Write a NEW key file (refuses to overwrite one), mode 0600; returns the public key. */
export function newKeyFile(path, what = 'onchato operator root key') {
  if (existsSync(path)) throw new Error(`${path} exists - refusing to overwrite a key`)
  const { privateKey } = generateKeyPairSync('ed25519')
  const priv = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64')
  writeFileSync(path, `# ${what}, Ed25519 private, base64. Keep it off any machine that builds.\n${priv}\n`, { mode: 0o600, flag: 'wx' })
  return pubOf(privateKey)
}

/** A signer from the command line's options, or null when none was named. */
export function signerFrom(opt, has) {
  if (has('--sign-yubikey')) {
    const slot = opt('--slot', '9c'), module = opt('--module')
    return {
      what: `YubiKey PIV ${slot}`,
      preflight: () => yubikeyPreflight(module),
      pub: () => publicKeyYubikey({ slot, module }),
      sign(bytes) {
        const tmp = join(tmpdir(), `onchato-sign-${process.pid}-${Date.now()}.bin`)
        writeFileSync(tmp, bytes, { mode: 0o600 })
        try { return signFileYubikey(tmp, { slot, module }) } finally { try { unlinkSync(tmp) } catch {} }
      },
    }
  }
  const file = opt('--sign')
  if (file) {
    const key = keyOf(readKeyFile(file))
    return {
      what: `key file ${file}`,
      preflight: () => [],
      pub: () => pubOf(key),
      sign: (bytes) => b64e(edSign(null, Buffer.from(bytes), key)),
    }
  }
  return null
}
