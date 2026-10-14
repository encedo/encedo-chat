/**
 * yubikey-sign.mjs - one Ed25519 signature from the root key in a YubiKey PIV
 * slot, through ykcs11 and pkcs11-tool (`apt install opensc ykcs11`; firmware
 * >= 5.7 for Ed25519). PIN and touch per signature. Shared by
 * release-manifest.mjs and approve-web.mjs, so the call lives in one place.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MODULES = ['/usr/lib/x86_64-linux-gnu/libykcs11.so', '/usr/lib/aarch64-linux-gnu/libykcs11.so', '/usr/local/lib/libykcs11.so', '/opt/homebrew/lib/libykcs11.dylib']
// PIV slot -> ykcs11 object id: 9a=1, 9c=2, 9d=3, 9e=4. 9c (Digital Signature) asks for the PIN every time.
const SLOT_ID = { '9a': '1', '9c': '2', '9d': '3', '9e': '4' }

/** What is missing before a YubiKey signature can work here, or [] if nothing. */
export function yubikeyPreflight(module) {
  const missing = []
  try { execFileSync('pkcs11-tool', ['--version'], { stdio: 'ignore' }) } catch (e) { if (e.code === 'ENOENT') missing.push('pkcs11-tool (apt install opensc)') }
  if (!(module ?? MODULES.find(existsSync))) missing.push('libykcs11 (apt install ykcs11)')
  return missing
}

/** Sign a file's exact bytes; returns the signature as base64. EDDSA = pure Ed25519, no prehash. */
export function signFileYubikey(file, { slot = '9c', module } = {}) {
  const id = SLOT_ID[slot.toLowerCase()]
  if (!id) throw new Error(`unknown PIV slot ${slot}`)
  const mod = module ?? MODULES.find(existsSync) ?? 'libykcs11.so'
  const tmp = join(tmpdir(), `onchato-yk-${process.pid}-${Date.now()}.sig`)
  try {
    execFileSync('pkcs11-tool', ['--module', mod, '--login', '--sign', '--mechanism', 'EDDSA', '--id', id, '--input-file', file, '--output-file', tmp], { stdio: 'inherit' })
    return Buffer.from(readFileSync(tmp)).toString('base64')
  } finally { try { unlinkSync(tmp) } catch {} }
}
