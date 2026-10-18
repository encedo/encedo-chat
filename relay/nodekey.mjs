/**
 * nodekey.mjs - a node's own random key, kept in a file.
 *
 * Our bs1-bs3 derive their key from `--pass` (SHA-256 of the host name), so
 * anyone can compute it; that stays until 0.9 (the PeerIds are compiled into
 * clients). Every other node - the Docker image, another operator's network -
 * gets `--key-file`: 32 random bytes made at first start, mode 0600, never
 * overwritten, the PeerId following from them.
 *
 *   file = an optional comment line, then the 32-byte Ed25519 seed in base64
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/** The seed in `path`, made there first if the file does not exist. `made` says which. */
export function loadOrCreateSeed(path) {
  if (!existsSync(path)) {
    const seed = randomBytes(32)
    writeFileSync(path, `# onchato node key (Ed25519 seed, base64) - the node's PeerId follows from it. Back it up; never share it.\n${seed.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    return { seed, made: true }
  }
  const line = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop() ?? ''
  const seed = Buffer.from(line, 'base64')
  if (seed.length !== 32 || seed.toString('base64') !== line) throw new Error(`${path} does not hold a 32-byte base64 node key`)
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) console.log(`WARNING: ${path} is readable by others (chmod 600)`)
  return { seed, made: false }
}
