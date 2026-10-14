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

const NO_TOKEN = 'a YubiKey this machine can see (plug it in; in a VM attach the USB device to the guest; `systemctl status pcscd`; `pkcs11-tool --module <libykcs11> --list-slots` must list a token)'

/** Is a token in a slot? pkcs11-tool says "No slots." or lists none when the key is absent or pcscd cannot reach it. */
function tokenPresent(mod) {
  try {
    const out = execFileSync('pkcs11-tool', ['--module', mod, '--list-slots'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    return /token label/i.test(out)
  } catch { return false }
}

/** What is missing before a YubiKey signature can work here, or [] if nothing. */
export function yubikeyPreflight(module) {
  const missing = []
  let tool = true
  try { execFileSync('pkcs11-tool', ['--version'], { stdio: 'ignore' }) } catch (e) { if (e.code === 'ENOENT') { tool = false; missing.push('pkcs11-tool (apt install opensc)') } }
  const mod = module ?? MODULES.find(existsSync)
  if (!mod) missing.push('libykcs11 (apt install ykcs11)')
  // Checked BEFORE the work that precedes signing (approve-web builds the tag
  // first): finding the key absent only at the signature cost a whole build.
  if (tool && mod && !tokenPresent(mod)) missing.push(NO_TOKEN)
  return missing
}

/** Sign a file's exact bytes; returns the signature as base64. EDDSA = pure Ed25519, no prehash. */
export function signFileYubikey(file, { slot = '9c', module } = {}) {
  const id = SLOT_ID[slot.toLowerCase()]
  if (!id) throw new Error(`unknown PIV slot ${slot}`)
  const mod = module ?? MODULES.find(existsSync) ?? 'libykcs11.so'
  // Again here: the key may have been pulled while the build ran.
  if (!tokenPresent(mod)) throw new Error(`no YubiKey to sign with - ${NO_TOKEN}`)
  const tmp = join(tmpdir(), `onchato-yk-${process.pid}-${Date.now()}.sig`)
  try {
    // stdio inherited: the PIN prompt is pkcs11-tool's own, and so is its
    // reason for refusing, printed just above whatever this throws.
    try {
      execFileSync('pkcs11-tool', ['--module', mod, '--login', '--sign', '--mechanism', 'EDDSA', '--id', id, '--input-file', file, '--output-file', tmp], { stdio: 'inherit' })
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('pkcs11-tool is not installed (apt install opensc)')
      throw new Error(`pkcs11-tool refused to sign (exit ${e.status ?? e.signal}) - see its line above: a wrong PIN (CKR_PIN_INCORRECT; three in a row lock the PIV PIN), no touch in time, the key pulled out, or no key in slot ${slot}. Nothing was signed.`)
    }
    if (!existsSync(tmp)) throw new Error('pkcs11-tool exited cleanly but wrote no signature - nothing was signed')
    return Buffer.from(readFileSync(tmp)).toString('base64')
  } finally { try { unlinkSync(tmp) } catch {} }
}
