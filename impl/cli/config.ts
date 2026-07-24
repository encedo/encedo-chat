/**
 * config.ts — local config + contact book for the `ec` CLI (ec.local.json).
 * Not secret (contacts are public keys), but kept local (git-ignored).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface EcConfig {
  source: 'hem' | 'software'
  hsm?: string                       // HEM url (source=hem)
  store?: string                     // keystore path (source=software)
  contacts: Record<string, string>   // name -> pubkey (base64)
}

export function loadConfig(path: string): EcConfig {
  if (!existsSync(path)) return { source: 'hem', contacts: {} }
  const c = JSON.parse(readFileSync(path, 'utf8'))
  c.contacts ??= {}
  return c
}

export function saveConfig(path: string, c: EcConfig): void {
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n')
}
