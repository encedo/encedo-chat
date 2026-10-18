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
 *   --sign-passphrase <root.kdf>                        a key DERIVED from a passphrase
 *                                                       (Argon2id); the file holds only the
 *                                                       salt, the parameters and the public
 *                                                       key - nothing secret is ever stored
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, argon2Sync, randomBytes } from 'node:crypto'
import { assessPassword, ENFORCE_MIN } from '../../impl/lib/passmeter.ts'
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

// ---- a key derived from a passphrase ----------------------------------------
//
// The operator's choice "the key on the server" (OPERATOR-NODE-PLAN.md): the
// Ed25519 seed is Argon2id(passphrase, salt), so nothing that signs is ever on
// the disk. The salt is random and kept PRIVATE (root.kdf, mode 600, and the
// operator's backup): the public key is in every profile, so with a public salt
// anyone could guess passphrases against it offline. With a private one an
// attacker needs the server or the backup first - the same bar as an encrypted
// key file. The passphrase cannot be changed: it IS the key.
const KDF = { alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1 }

function deriveSeed(passphrase, kdf) {
  return argon2Sync('argon2id', {
    message: Buffer.from(passphrase.normalize('NFC'), 'utf8'), nonce: Buffer.from(kdf.salt, 'base64'),
    memory: kdf.memoryKiB, passes: kdf.passes, parallelism: kdf.parallelism, tagLength: 32,
  })
}

/** Write a NEW root.kdf for this passphrase (refuses a weak one, never overwrites); returns the public key. */
export function newPassphraseKey(path, passphrase) {
  if (existsSync(path)) throw new Error(`${path} exists - refusing to replace a network's key`)
  const s = assessPassword(passphrase)
  if (s.score < ENFORCE_MIN) throw new Error(`the passphrase is too weak (${s.advice}) - use several unrelated words, 16+ characters`)
  const kdf = { v: 1, ...KDF, salt: randomBytes(16).toString('base64') }
  const pub = pubOf(keyOf(b64e(deriveSeed(passphrase, kdf))))
  writeFileSync(path, JSON.stringify({ ...kdf, pub }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return pub
}

/** The kdf file: its parameters, salt and public key. */
export function readKdf(path) {
  const k = JSON.parse(readFileSync(path, 'utf8'))
  if (k.v !== 1 || k.alg !== 'argon2id' || !k.salt || !k.pub) throw new Error(`${path} is not an onchato root.kdf`)
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) console.error(`WARNING: ${path} is readable by others (chmod 600) - the salt is meant to stay private`)
  return k
}

/** The key for a passphrase, checked against the public key the file names. */
export function passphraseKey(path, passphrase) {
  const kdf = readKdf(path)
  const key = keyOf(b64e(deriveSeed(passphrase, kdf)))
  if (pubOf(key) !== kdf.pub) throw new Error('wrong passphrase (the derived key is not this network\'s key) - nothing was signed')
  return key
}

/** A secret from the terminal without echo, or the first line of stdin when it is not a terminal. */
export async function readSecret(prompt) {
  const input = process.stdin
  if (!input.isTTY) {
    let all = ''
    for await (const chunk of input) all += chunk
    return all.split('\n')[0].replace(/\r$/, '')
  }
  process.stderr.write(prompt)
  input.setRawMode(true); input.resume(); input.setEncoding('utf8')
  return await new Promise((ok, fail) => {
    let got = ''
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return ok(got) }
        if (c === '\u0003') { done(); return fail(new Error('cancelled')) }
        if (c === '\u007f' || c === '\b') got = got.slice(0, -1)
        else got += c
      }
    }
    const done = () => { input.off('data', on); input.setRawMode(false); input.pause(); process.stderr.write('\n') }
    input.on('data', on)
  })
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
  const kdfFile = opt('--sign-passphrase')
  if (kdfFile) {
    const kdf = readKdf(kdfFile)
    let key = null
    return {
      what: `passphrase key ${kdfFile}`,
      preflight: () => [],
      pub: () => kdf.pub,
      // Derived once, on the first signature, so the passphrase is asked after every check that can fail without it.
      async unlock() { key = passphraseKey(kdfFile, await readSecret('Network key passphrase: ')) },
      sign(bytes) { if (!key) throw new Error('not unlocked'); return b64e(edSign(null, Buffer.from(bytes), key)) },
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
