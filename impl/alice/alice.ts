/**
 * alice.ts — CLI for the real-HEM peer "Alice" in the live rendezvous test.
 *
 * Talks to Alice's HEM (URL from --hsm) via hem-sdk-js. The identity private key
 * is created and stays inside the HEM; ECDH runs on the device (raw output).
 *
 *   node alice/alice.ts register --hsm <url> [--handle alice]
 *   node alice/alice.ts pubkey
 *   node alice/alice.ts topic <peer> --peer-pub <b64> [--network m] [--date YYYY-MM-DD]
 *
 * Password: --password <pw>, or HEM_PASSWORD env, or interactive prompt (masked).
 *
 * Flow: register → give printed pubkey to Bob (`bob add-peer alice <pub>`);
 *       take Bob's pubkey → `topic bob --peer-pub <bob_pub>`.
 *       Compare with `bob topic alice` — the two topics MUST be identical.
 */

import { HEM } from '../../hem-sdk-js/hem-sdk.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { topicFromSecret, announceMacKey, todayUTC } from '../lib/rendezvous.ts'

const LOCAL = new URL('./alice.local.json', import.meta.url).pathname
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def }

const encodeDescr = (plain) => Buffer.from(plain, 'utf8').toString('base64')

function loadLocal() {
  if (!existsSync(LOCAL)) { console.error('Not registered — run: node alice/alice.ts register --hsm <url>'); process.exit(1) }
  return JSON.parse(readFileSync(LOCAL, 'utf8'))
}

async function getPassword() {
  const flag = opt('--password'); if (flag) return flag
  if (process.env.HEM_PASSWORD) return process.env.HEM_PASSWORD
  return await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let mask = false
    rl.question('HEM password: ', (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
    rl._writeToOutput = (s) => process.stdout.write(mask ? '*' : s)
    mask = true
  })
}

async function connect(hsmUrl) {
  const hem = new HEM(hsmUrl, { debug: rest.includes('--debug') })
  await hem.hemCheckin()   // fast-fail + clock sync before auth (pattern from encedo-pgp)
  return hem
}

switch (cmd) {
  case 'register': {
    const hsmUrl = opt('--hsm'); if (!hsmUrl) { console.error('usage: register --hsm <url> [--handle alice]'); process.exit(1) }
    if (existsSync(LOCAL)) { console.error(`Already registered (kid ${loadLocal().kid}). Delete ${LOCAL} to re-register.`); process.exit(1) }
    const handle = opt('--handle', 'alice')
    const hem = await connect(hsmUrl)
    const pw = await getPassword()
    const iat = Math.floor(Date.now() / 1000)
    const descr = `ETSEIC:self,${handle},ik,${iat}`
    const genToken = await hem.authorizePassword(pw, 'keymgmt:gen')
    const { kid } = await hem.createKeyPair(genToken, `chat-ik-${handle}`, 'CURVE25519', encodeDescr(descr))
    const useToken = await hem.authorizePassword(null, `keymgmt:use:${kid}`)   // null → reuse cached pw-derived key
    const { pubkey } = await hem.getPubKey(useToken, kid)
    writeFileSync(LOCAL, JSON.stringify({ handle, hsmUrl, kid, pub: pubkey }, null, 2) + '\n')
    console.log(`Alice registered — handle "${handle}"`)
    console.log(`DESCR:  ${descr}`)
    console.log(`kid:    ${kid}`)
    console.log(`pubkey: ${pubkey}`)
    console.log(`\n→ give this pubkey to Bob:  node bob/bob.ts add-peer ${handle} ${pubkey}`)
    break
  }
  case 'pubkey':
    console.log(loadLocal().pub)
    break

  case 'topic': {
    const peer = rest[0]; const peerPub = opt('--peer-pub')
    if (!peer || !peerPub) { console.error('usage: topic <peer> --peer-pub <b64> [--network m] [--date YYYY-MM-DD]'); process.exit(1) }
    const { hsmUrl, kid } = loadLocal()
    const p = { networkId: opt('--network', 'main'), dateUTC: opt('--date', todayUTC()) }
    const hem = await connect(hsmUrl)
    const pw = await getPassword()
    const useToken = await hem.authorizePassword(pw, `keymgmt:use:${kid}`)
    const ss = await hem.ecdh(useToken, kid, peerPub)   // Uint8Array, raw 32-byte shared secret
    console.log(`peer:    ${peer}`)
    console.log(`network: ${p.networkId}    date: ${p.dateUTC} (UTC)`)
    console.log(`topic:   ${topicFromSecret(ss, p)}`)
    console.log(`macKey:  ${announceMacKey(ss, p).toString('hex').slice(0, 24)}…`)
    break
  }
  case 'list': {
    const hsmUrl = opt('--hsm') ?? (existsSync(LOCAL) ? loadLocal().hsmUrl : undefined)
    if (!hsmUrl) { console.error('usage: list [--pattern ETSEIC:] --hsm <url>'); process.exit(1) }
    const pattern = opt('--pattern', 'ETSEIC:')
    const hem = await connect(hsmUrl)
    const pw = await getPassword()
    const token = await hem.authorizePassword(pw, 'keymgmt:list')
    const keys = await hem.searchKeys(token, pattern)   // SDK anchors: ^ + base64(pattern)
    const dec = new TextDecoder()
    for (const k of keys) {
      const descr = k.description ? dec.decode(k.description).replace(/\n+$/, '') : '(no descr)'
      console.log(`${k.kid}  ${descr.padEnd(34)}  [${k.type}]  "${k.label}"`)
    }
    console.log(`\n(${keys.length} key(s) matching "${pattern}")`)
    break
  }
  default:
    console.log('usage: alice <register --hsm <url> [--handle h]|pubkey|list [--pattern ETSEIC:] --hsm <url>|topic <peer> --peer-pub <b64> [--network m] [--date d]>  [--password pw]')
}
