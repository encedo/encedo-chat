/**
 * store.ts - the CLI's storage: the browser's keys, in one file.
 *
 * The app keeps everything a profile owns under `ec-*` keys in localStorage
 * (the sealed identity `ec-soft-id-<name>`, the contact book per KID, the §10
 * emp key, groups later). The CLI keeps the SAME keys in a JSON file, which is
 * what lets lib/migrate.ts move a profile between the two unchanged and
 * lib/localbook.ts read the contact book with one implementation.
 *
 *   $ONCHATO_HOME, else $XDG_CONFIG_HOME/onchato, else ~/.config/onchato
 *     store.json   0600, written atomically (temp file + rename)
 *
 * The directory is 0700. What sits here is what a browser profile holds: a
 * sealed identity, a signed contact book, nothing in plaintext that is secret.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { KV } from '../lib/migrate.ts'

export function onchatoHome(): string {
  if (process.env.ONCHATO_HOME) return process.env.ONCHATO_HOME
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'onchato')
}

export interface FileKV extends KV { remove(key: string): void; readonly path: string }

export function fileKV(dir = onchatoHome()): FileKV {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'store.json')
  let data: Record<string, string> = {}
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    try { data = JSON.parse(raw) } catch { throw new Error(`${path} is not valid JSON - not touching it`) }
  }
  const flush = () => {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600) // rename keeps the temp file's mode; say it anyway
  }
  return {
    path,
    keys: () => Object.keys(data),
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => { data[k] = v; flush() },
    remove: (k) => { if (k in data) { delete data[k]; flush() } },
  }
}
