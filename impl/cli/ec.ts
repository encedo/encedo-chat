/**
 * ec.ts — Encedo Chat, one terminal client (IRC-style). The product CLI.
 *
 *   node cli/ec.ts register --hsm <url> [--handle h]     HEM identity (or --store <file> for software)
 *   node cli/ec.ts whoami                                 show my identity + fingerprint
 *   node cli/ec.ts pubkey                                 print my pubkey (give it to a contact)
 *   node cli/ec.ts add <name> <pubB64>                    save a contact
 *   node cli/ec.ts contacts                               list contacts
 *   node cli/ec.ts chat <name> [--network m] [--date d] [--no-eh2]  open an interactive encrypted chat
 *                              (EH-2 handshake + ratchet by default; --no-eh2 = the old interim key)
 *
 * Password: --password, EC_PASSWORD env, or interactive prompt (masked).
 * Identity in the HEM (real) or a local keystore (dev). Same engine as the web GUI.
 */

import { createInterface } from 'node:readline'
import { hemIdentity, softwareIdentity, type Identity } from './identity.ts'
import { loadConfig, saveConfig, type EcConfig } from './config.ts'
import { todayUTC } from '../lib/rendezvous.ts'
import { runChatSession } from './chat-session.ts'

const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const CFG = new URL('./ec.local.json', import.meta.url).pathname

const [cmd, ...rest] = process.argv.slice(2)
const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def }

async function getPassword(): Promise<string> {
  const flag = opt('--password'); if (flag) return flag
  if (process.env.EC_PASSWORD) return process.env.EC_PASSWORD
  return await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let mask = false
    rl.question('HEM password: ', (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
    ;(rl as any)._writeToOutput = (s: string) => process.stdout.write(mask ? '*' : s)
    mask = true
  })
}

async function connect(cfg: EcConfig): Promise<Identity> {
  if (cfg.source === 'software') {
    if (!cfg.store) throw new Error('no keystore configured — run: ec register --store <file>')
    return softwareIdentity(cfg.store, opt('--handle', 'me')!)
  }
  if (!cfg.hsm) throw new Error('no HEM configured — run: ec register --hsm <url>')
  return hemIdentity(cfg.hsm, await getPassword(), opt('--handle', 'me')!)
}

async function fingerprint(pubB64: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(Buffer.from(pubB64, 'base64')))).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

switch (cmd) {
  case 'register': {
    const hsm = opt('--hsm'), store = opt('--store')
    if (!hsm && !store) { console.error('usage: register --hsm <url> | --store <file>  [--handle h]'); process.exit(1) }
    const cfg = loadConfig(CFG)
    if (store) { cfg.source = 'software'; cfg.store = store } else { cfg.source = 'hem'; cfg.hsm = hsm }
    const id = await connect(cfg)
    saveConfig(CFG, cfg)
    console.log(`identity: ${id.handle}`)
    console.log(`pubkey:   ${id.pub}`)
    console.log(`fp:       ${await fingerprint(id.pub)}`)
    console.log(`\n→ give your pubkey to a contact; they run:  ec add ${id.handle} ${id.pub}`)
    break
  }
  case 'whoami': {
    const id = await connect(loadConfig(CFG))
    console.log(`handle:   ${id.handle}`)
    console.log(`pubkey:   ${id.pub}`)
    console.log(`fp:       ${await fingerprint(id.pub)}`)
    break
  }
  case 'pubkey': {
    console.log((await connect(loadConfig(CFG))).pub)
    break
  }
  case 'add': {
    const [name, pub] = rest
    if (!name || !pub || pub.startsWith('--')) { console.error('usage: add <name> <pubB64>'); process.exit(1) }
    const cfg = loadConfig(CFG); cfg.contacts[name] = pub; saveConfig(CFG, cfg)
    console.log(`contact saved: ${name}`)
    break
  }
  case 'contacts': {
    const cfg = loadConfig(CFG)
    const names = Object.keys(cfg.contacts)
    console.log(names.length ? names.map((n) => `  ${n}  ${cfg.contacts[n].slice(0, 16)}…`).join('\n') : '(no contacts — ec add <name> <pubB64>)')
    break
  }
  case 'chat': {
    const name = rest[0]
    if (!name || name.startsWith('--')) { console.error('usage: chat <name> [--network m] [--date d]'); process.exit(1) }
    const cfg = loadConfig(CFG)
    const peerPub = cfg.contacts[name]
    if (!peerPub) { console.error(`unknown contact: ${name} (ec add ${name} <pubB64>)`); process.exit(1) }
    const id = await connect(cfg)
    const p = { networkId: opt('--network', 'main')!, dateUTC: opt('--date', todayUTC())! }
    // EH-2 is the default; `--no-eh2` is the escape hatch for talking to a peer
    // that still runs the interim key (`--eh2` kept so old habits still work).
    const eh2 = !rest.includes('--no-eh2')
    console.log(`[ec] ${id.handle} → ${name}  via onchato relay${eh2 ? '  [EH-2]' : '  [interim key]'}`)
    await runChatSession(id, peerPub, id.handle, name, RELAY, p, eh2)
    break
  }
  default:
    console.log('usage: ec <register|whoami|pubkey|add <name> <pub>|contacts|chat <name>>  [--hsm url | --store file] [--password pw]')
}
