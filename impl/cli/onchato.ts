#!/usr/bin/env node
/**
 * onchato.ts - the terminal client (CLI-PLAN.md, stage 1: the foundation).
 *
 *   onchato-cli profile new <name>                 a software identity, sealed (browser format)
 *   onchato-cli profile list
 *   onchato-cli hem new <name> --hem <url>          a new onchato identity on a HEM (sign-in never creates one)
 *   onchato-cli profile import <file.ocmig>        the app's "move profile" file
 *   onchato-cli profile export <name> <file>
 *   onchato-cli whoami | pubkey | contacts
 *   onchato-cli invite [--qr]                     my identity link (and the code, drawn in the terminal)
 *   onchato-cli invites [new [label] [--expires 24h] [--qr] | qr <n> | revoke <n>]
 *                                              invites that answer themselves: whoever opens one knocks,
 *                                              and the client (onchato-cli chat) shows the knock to accept
 *   onchato-cli add <link|code> [--name n] [--yes] a contact from an invite - fingerprint shown, confirmed
 *   onchato-cli add <name> <pubB64>                a contact by raw key
 *   onchato-cli verify <name> [--qr] [<number>]    the pair's safety number; compare one read out to you
 *   onchato-cli chat [<name>] [--debug]           the irssi-style client (windows, Alt+N, /help)
 *   onchato-cli send <name> <text|-> [--wait s] [--ttl 24h] [--key k] [--json]   exit 0 delivered, 3 queued
 *   onchato-cli send-file <name> <path> [--wait s] [--json]   a file (the store keeps it ~5 min)
 *   onchato-cli listen [--json] [--save-files <dir>]   incoming messages and files as lines
 *   onchato-cli get <id> [--dir <dir>]             save a received file (through the daemon)
 *   onchato-cli daemon                             keep the session up; send/listen go through its socket
 *   onchato-cli queue                              what waits in the daemon for whom
 *
 * Which identity: --profile <name> (a software profile here), or --hem <url>
 * [--handle h] (a HEM). With neither, the only profile there is.
 * Passwords: --password, $ONCHATO_PASSWORD, or a masked prompt.
 * Storage: $ONCHATO_HOME, else $XDG_CONFIG_HOME/onchato, else ~/.config/onchato.
 */

import { fileKV, type FileKV } from './store.ts'
import { listProfiles, createProfile, openProfile, exportProfileFile, importProfileFile, identityKey } from './profiles.ts'
import { hemSignIn, hemCreate, type HemChoice } from './identity.ts'
import { runClient } from './client.ts'
import { loadOrCreateNetKey, netPeerId } from '../lib/netkey.ts'
import { Hub, type HubEvent, APP_ORIGIN, APP_PATH, setAppAddress } from './hub.ts'
import { NET } from './network.ts'
import { builtinNetwork, networkById, bindingOf, setBinding, nodesKey, softBindingKey, hemBindingKey } from '../lib/activenet.ts'
import { openEnvelope, registerNetwork, rootFingerprint, parseNetworkPointer, fetchPointed, loadRegistry } from '../lib/netprofile.ts'
import { setStoreOrigins } from '../net/ipfs.ts'
import { serve, connectDaemon, ask, lineReader, socketPath } from './daemon.ts'
import { Queue } from './queue.ts'
import { existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { humanSize } from './files.ts'
import { readFileSync } from 'node:fs'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'
import { sealPlainStores } from '../lib/sealedstore.ts'
import { namesFor, migrateToNames, type Names } from '../lib/storenames.ts'
import { hemContactBook, mergedContactBook, localOnlyManager, type ContactManager, type Identity } from '../lib/core.ts'
import { setCoreBackend } from '../eh2/establish.ts'
import { BadPassword } from '../lib/profile.ts'
import { inviteFromPaste, inviteLink, setInviteNetwork, inviteNetwork } from '../lib/invite.ts'
import { safetyNumber, safetyGroups, safetyQr, parseSafetyQr } from '../lib/safety.ts'
import { qrForTerminal } from './termqr.ts'
import { fingerprint } from './fp.ts'
import { InviteStore, publishedLink, parseDuration, expired, type Waiting } from './invites.ts'
import { startSession } from '../lib/core.ts'
import { regionBlocked } from '../lib/regioncheck.ts'
import { hostOf } from '../lib/ice.ts'
import { REGION_MSG } from './client.ts'
import { inboxSecretBytes } from '../lib/invite.ts'
import { createInterface } from 'node:readline/promises'

/** Where invite links point (app.ts CANONICAL_ORIGIN/PATH): the CLI has no address bar either. */
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** y/N on a terminal; refused without one unless --yes was given. */
async function confirm(q: string): Promise<boolean> {
  if (rest.includes('--yes')) return true
  if (!process.stdin.isTTY) die('bez terminala potrzebne jest --yes')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(q + ' [t/N] ')).trim().toLowerCase()
  rl.close()
  return a === 't' || a === 'y' || a === 'tak' || a === 'yes'
}

/**
 * The relays, in failover order: the node list a profile brought from the app
 * (`ec-nodes`, enabled ones, the app's own format), else the published list
 * compiled into the repo (infra/nodes.json, the same file the app ships).
 */
/**
 * The stable libp2p key of this identity, in a network that admits devices by
 * list (lib/netkey.ts); undefined anywhere else (a fresh PeerId, as always).
 */
async function peerKeyOf(kv: FileKV, base: Uint8Array | null, names: Names): Promise<Uint8Array | undefined> {
  if (ACTIVE.policy.access !== 'allowlist') return undefined
  const k = await loadOrCreateNetKey(kv, base, names, (m) => console.error('onchato: ' + m))
  if (k) console.error(`onchato: sieć wpuszcza urządzenia z listy - to urządzenie: ${netPeerId(k)}`)
  return k ?? undefined
}

function relayList(kv: FileKV): string[] {
  try {
    const mine = JSON.parse(kv.get(nodesKey(ACTIVE)) ?? 'null')
    const on = Array.isArray(mine) ? mine.filter((n: any) => n?.enabled !== false && typeof n?.addr === 'string').map((n: any) => n.addr) : []
    if (on.length) return on
  } catch {}
  return ACTIVE.nodes.map((n) => n.addr)
}
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def }
const args = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && opt(rest[i - 1]) === a))
const die = (msg: string): never => { console.error('onchato: ' + msg); process.exit(1) }
// The handshake and the ratchet from core-rs (eh2/wasm.ts) by default;
// `--core ts` selects the TypeScript engine.
if (opt('--core') !== 'ts') setCoreBackend('wasm')

/** A secret from the flag, the environment, or a masked prompt (stdin when piped). */
async function secret(prompt: string, envName = 'ONCHATO_PASSWORD'): Promise<string> {
  const flag = opt('--password'); if (flag) return flag
  if (process.env[envName]) return process.env[envName]!
  // A file (0600), or systemd's LoadCredential=onchato-password:<path> - how a
  // daemon gets its password without it sitting in the unit or the environment.
  const file = opt('--password-file') ?? (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, 'onchato-password') : undefined)
  if (file && existsSync(file)) return readFileSync(file, 'utf8').split('\n')[0]
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let buf = ''; for await (const c of stdin) buf += c
    return buf.split('\n')[0]
  }
  process.stdout.write(prompt)
  return await new Promise((resolve) => {
    let s = ''
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8')
    const on = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); resolve(s); return }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130) }
        if (c === '\u007f' || c === '\b') { if (s) { s = s.slice(0, -1); process.stdout.write('\b \b') } continue }
        s += c; process.stdout.write('*')
      }
    }
    stdin.on('data', on)
  })
}


/**
 * Several identities on one HEM: a numbered list, the KID's start beside each
 * name (handles may repeat), and a number to type. Without a terminal there is
 * nobody to ask, so the caller's error (with the list) stands.
 */
async function chooseIdentity(ids: HemChoice[]): Promise<HemChoice | null> {
  if (!process.stdin.isTTY) return null
  console.log('Ten HEM ma kilka tożsamości:')
  ids.forEach((i, n) => console.log(`  ${n + 1}) ${i.handle.padEnd(16)} KID ${i.kid.slice(0, 8)}…`))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const a = (await rl.question(`Która? [1-${ids.length}] `)).trim()
      const n = Number(a)
      if (Number.isInteger(n) && n >= 1 && n <= ids.length) return ids[n - 1]
      if (!a) return null
      console.log('  podaj numer z listy (Enter przerywa)')
    }
  } finally { rl.close() }
}

/** The identity this command runs as, and its contact book (signed, §4.4). */
async function signIn(kv: FileKV): Promise<{ id: Identity; contacts: ContactManager; kind: string; store: InviteStore; key: string; names: Names; base: Uint8Array | null }> {
  const hemUrl = opt('--hem')
  if (hemUrl) {
    const { id, hem, kid } = await hemSignIn(hemUrl, await secret('Hasło HEM: '), opt('--handle'), chooseIdentity)
    // A HEM identity's network is recorded on this device (lib/activenet.ts);
    // one recorded elsewhere than this process's network is refused.
    const rec = kv.get(hemBindingKey(kid))
    if (rec && rec !== NETWORK) die(`tozsamosc HEM ${id.handle} jest w sieci "${rec}" - uruchom z --network ${rec}`)
    if (!rec && !ACTIVE.builtin) kv.set(hemBindingKey(kid), NETWORK)
    const key = await identityKey(id.pub, kid)
    // Two derivations for the whole sign-in (on a HEM each is a device call):
    // the storage names, then the §10 base under the name they give emp_pub.
    const names = await namesFor(id, key)
    await migrateToNames(kv, names)
    const base = await cacheBaseOf(id, names, kv)
    const local = await openLocalBook(names, kv, base)
    if (local.verdict === 'tampered') console.error('onchato: UWAGA - lokalna książka kontaktów nie przeszła weryfikacji (pokazuję tylko kontakty z HEM)')
    await sealPlainStores(kv, base, names)
    return { id, kind: 'HEM', key, names, base, store: new InviteStore(kv, base, names), contacts: mergedContactBook(hemContactBook(hem, kid), local.verdict === 'tampered' ? emptyBook() : local.book) }
  }
  const profiles = listProfiles(kv)
  const name = opt('--profile') ?? (profiles.length === 1 ? profiles[0] : undefined)
  if (!name) die(profiles.length ? `kilka profili (${profiles.join(', ')}) - wybierz --profile <nazwa>` : 'brak profilu - onchato-cli profile new <nazwa> albo profile import <plik>')
  let id: Identity
  try { id = await openProfile(kv, name!, await secret(`Hasło profilu ${name}: `)) }
  catch (e) { die(e instanceof BadPassword ? 'złe hasło' : (e as Error).message) }
  const key = await identityKey(id!.pub)
  const names = await namesFor(id!, key)
  await migrateToNames(kv, names)
  const base = await cacheBaseOf(id!, names, kv)
  const local = await openLocalBook(names, kv, base)
  if (local.verdict === 'tampered') die('książka kontaktów nie przeszła weryfikacji - ktoś zmienił ' + kv.path + ' (nic nie nadpisuję)')
  await sealPlainStores(kv, base, names)
  return { id: id!, kind: 'software', key, names, base, store: new InviteStore(kv, base, names), contacts: localOnlyManager(local.book) }
}
const emptyBook = () => ({ list: async () => [], add: async () => { throw new Error('książka zablokowana') }, remove: async () => {}, rename: async () => {} })

const kv = fileKV()

/**
 * The network this process works in, as the app's page does (lib/activenet.ts):
 * the chosen profile's (`--profile`, or the only one), else `--network` (how a
 * HEM sign-in names one), else the built-in network. A profile is in one
 * network for good; asking for another one is refused, not obeyed.
 * `--network` with an id this client does not know stays what it always was -
 * the built-in network's nodes under another id, for development.
 */
const BUILTIN = builtinNetwork(NET, JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes)
const PROFILE_HINT = opt('--hem') ? undefined : (opt('--profile') ?? (() => { const p = listProfiles(kv); return p.length === 1 ? p[0] : undefined })())
const BOUND = PROFILE_HINT ? bindingOf(kv, softBindingKey(PROFILE_HINT), BUILTIN) : null
if (BOUND && opt('--network') && opt('--network') !== BOUND) die(`profil ${PROFILE_HINT} jest w sieci "${BOUND}", nie w "${opt('--network')}" - tozsamosc nie zmienia sieci`)
const WANTED = BOUND ?? opt('--network') ?? BUILTIN.id
const ACTIVE = networkById(kv, WANTED, BUILTIN, Date.now())
  ?? (BOUND ? die(`profil ${PROFILE_HINT} jest w sieci "${BOUND}", ktorej profilu nie ma juz na tym urzadzeniu`) : { ...BUILTIN, id: WANTED })
/** The network topics are derived for (SPEC.md 5.1). */
const NETWORK = ACTIVE.id
// Every invite link this client writes names its network and its app; files go to its stores.
setInviteNetwork(NETWORK)
setAppAddress(ACTIVE.app)
if (!process.env.ONCHATO_STORE) setStoreOrigins(ACTIVE.stores)
try {
  switch (cmd) {
    case 'profile': {
      const [sub, a, b] = args
      if (sub === 'list') {
        // Each profile with its network when it is not the built-in one.
        const n = listProfiles(kv).map((p) => { const net = bindingOf(kv, softBindingKey(p), BUILTIN); return net === BUILTIN.id ? p : `${p}  [siec: ${networkById(kv, net, BUILTIN, Date.now())?.operator ?? net} (${net})]` })
        console.log(n.length ? n.join('\n') : '(brak profili)'); break
      }
      if (sub === 'new') {
        if (!a) die('użycie: profile new <nazwa> [--network-profile <plik|link>]')
        // Another operator's network: its signed profile, from a file or the short
        // link with its CID; shown, confirmed, registered - and the new identity
        // lives in it for good (lib/netprofile.ts, lib/activenet.ts).
        let net = BUILTIN.id
        const src = opt('--network-profile')
        if (src) {
          let text: string
          const ptr = parseNetworkPointer(src)
          if (ptr) { const got = await fetchPointed(ptr); if (!got.ok) die(got.why === 'cid' ? 'pobrany plik NIE zgadza sie z CID w linku - nie dolaczam' : `nie udalo sie pobrac ${ptr.url}`); text = (got as any).text }
          else { try { text = readFileSync(src, 'utf8') } catch { die(`nie moge przeczytac ${src}`) } }
          const r = openEnvelope(text!, Date.now())
          if (!r.ok) die(`profil sieci odrzucony: ${r.why}${r.detail ? ' (' + r.detail + ')' : ''}`)
          const p = (r as any).profile
          const held = loadRegistry(kv, Date.now()).get(p.networkId)
          if (held && held.profile.rootPub !== p.rootPub) die(`siec "${p.networkId}" jest juz tu pod INNYM kluczem operatora - nie dolaczam`)
          if (p.policy.softwareProfiles === false) die(`siec "${p.networkId}" wymaga tozsamosci w HEM - uzyj: hem new <nazwa> --hem <url> --network ${p.networkId}`)
          console.log(`siec:      ${p.operator} (${p.networkId})\nodcisk:    ${await rootFingerprint(p.rootPub)}\nwezly:     ${p.nodes.length}\nwazny do:  ${new Date(p.expires).toISOString().slice(0, 10)}\nPorownaj odcisk z tym, co operator podal innym kanalem. Operator zobaczy adres IP tego urzadzenia i czas spotkan, nie tresc.`)
          if (!await confirm('Dolaczyc i utworzyc tozsamosc w tej sieci?')) die('nie utworzono')
          const reg = registerNetwork(kv, (r as any).envelope, Date.now())
          if (!reg.ok) die(`profil sieci odrzucony: ${reg.why}`)
          net = p.networkId
        }
        const pw = await secret('Nowe hasło: ')
        if (!opt('--password') && !process.env.ONCHATO_PASSWORD && pw !== await secret('Powtórz hasło: ')) die('hasła się różnią')
        const id = await createProfile(kv, a, pw)
        setBinding(kv, softBindingKey(a), net, BUILTIN)
        console.log(`profil ${a} utworzony${net !== BUILTIN.id ? ` w sieci ${net}` : ''}\nklucz:  ${id.pub}\nodcisk: ${await fingerprint(id.pub)}`)
        break
      }
      if (sub === 'import') {
        if (!a) die('użycie: profile import <plik.ocmig>')
        const r = await importProfileFile(kv, a, await secret('Hasło profilu z pliku: '))
        console.log(`zaimportowano profil ${r.name} (${r.keys} wpisów) - to PRZENIESIENIE: nie używaj go już w przeglądarce, z której pochodzi`)
        break
      }
      if (sub === 'export') {
        if (!a || !b) die('użycie: profile export <nazwa> <plik.ocmig>')
        await exportProfileFile(kv, a, await secret(`Hasło profilu ${a}: `), b)
        console.log(`zapisano ${b} (0600) - plik jest zabezpieczony hasłem profilu`)
        break
      }
      die('użycie: profile new|list|import|export')
      break
    }
    case 'hem': {
      const [sub, name] = args
      const url = opt('--hem')
      if (sub !== 'new' || !name || !url) die('użycie: hem new <nazwa> --hem <url>')
      console.log(`Tworzę na HEM nową tożsamość onchato „${name}” - klucz powstaje w urządzeniu i go nie opuszcza.`)
      if (!await confirm('Utworzyć?')) die('nie utworzono')
      const { id } = await hemCreate(url!, await secret('Hasło HEM: '), name)
      console.log(`utworzono ${id.handle}\nklucz:  ${id.pub}\nodcisk: ${await fingerprint(id.pub)}`)
      break
    }
    case 'whoami': {
      const { id, kind } = await signIn(kv)
      console.log(`tożsamość: ${id.handle} (${kind})\nklucz:     ${id.pub}\nodcisk:    ${await fingerprint(id.pub)}\nsieć:      ${ACTIVE.builtin ? NETWORK : `${ACTIVE.operator} (${NETWORK})`}`)
      break
    }
    case 'pubkey': console.log((await signIn(kv)).id.pub); break
    case 'contacts': {
      const list = await (await signIn(kv)).contacts.list()
      console.log(list.length ? (await Promise.all(list.map(async (c) => `  ${c.name.padEnd(16)} ${await fingerprint(c.pub)}  ${c.source}`))).join('\n') : '(brak kontaktów - onchato-cli add <nazwa> <klucz>)')
      break
    }
    case 'invite': {
      const { id } = await signIn(kv)
      const link = inviteLink(APP_ORIGIN, APP_PATH, { pub: id.pub, name: id.handle })
      console.log(`Twoje zaproszenie (${id.handle}, odcisk ${await fingerprint(id.pub)}):\n${link}`)
      if (rest.includes('--qr')) console.log('\n' + qrForTerminal(link))
      break
    }
    case 'invites': {
      const [sub, ...more] = args
      const when = (t: number) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      const usage = 'użycie: invites [list] | new [etykieta] [--expires 24h] [--qr] | qr <nr> | revoke <nr>'
      // The daemon holds store.json in memory and rewrites it whole: an invite
      // written beside it would go unheard, then be overwritten by its next
      // save. So with a daemon running, the daemon makes and drops invites -
      // and listens on a new one at once.
      const dsock = await connectDaemon()
      if (dsock) {
        const call = async (req: unknown) => { const r = await ask(dsock, req); if (!r.ok) { dsock.end(); die(r.error) } return r }
        const listD = async () => (await call({ op: 'invites' })).invites as any[]
        const pickD = async (n: string) => (await listD()).find((i) => i.n === Number(n)) ?? (dsock.end(), die(`nie ma zaproszenia nr ${n} (onchato-cli invites)`))
        if (!sub || sub === 'list') {
          const l = await listD()
          if (!l.length) console.log('(brak zaproszeń - onchato-cli invites new <etykieta>)')
          for (const i of l) console.log(`  ${i.n}) ${String(i.label).padEnd(16)} od ${when(i.created)}  ${i.expires ? (i.expired ? 'WYGASŁO' : 'do ' + when(i.expires)) : 'bez terminu'}\n     ${i.link}`)
          if (l.length) console.log('Demon słucha tych zaproszeń - pukanie: onchato-cli knocks.')
        } else if (sub === 'new') {
          const r = await call({ op: 'invite-new', label: more.join(' '), ttl: opt('--expires') ? parseDuration(opt('--expires')!) : undefined })
          console.log(`zaproszenie „${r.label}”${r.expires ? ' do ' + when(r.expires) : ' bez terminu'}:\n${r.link}`)
          if (rest.includes('--qr')) console.log('\n' + qrForTerminal(r.link))
          console.log('Demon już go słucha - kto je otworzy, zapuka: onchato-cli knocks, accept N.')
        } else if (sub === 'qr') {
          console.log(qrForTerminal((await pickD(more[0])).link))
        } else if (sub === 'revoke') {
          const i = await pickD(more[0])
          await call({ op: 'invite-revoke', id: i.id })
          console.log(`wycofano „${i.label}” - nikt nie jest o tym informowany, nowe pukanie już nie dotrze`)
        } else { dsock.end(); die(usage) }
        dsock.end()
        break
      }
      const { id, store } = await signIn(kv)
      const list = await store.invites()
      const pick = (n: string) => list[Number(n) - 1] ?? die(`nie ma zaproszenia nr ${n} (onchato-cli invites)`)
      if (!sub || sub === 'list') {
        if (!list.length) { console.log('(brak zaproszeń - onchato-cli invites new <etykieta>)'); break }
        for (const [i, inv] of list.entries()) console.log(`  ${i + 1}) ${inv.label.padEnd(16)} od ${when(inv.created)}  ${inv.expires ? (expired(inv) ? 'WYGASŁO' : 'do ' + when(inv.expires)) : 'bez terminu'}\n     ${await publishedLink(APP_ORIGIN, APP_PATH, id, inv)}`)
        console.log('Pukanie widać w kliencie (onchato-cli chat) albo w demonie (onchato-cli knocks) - zaproszenie słucha tylko, gdy któryś działa.')
        break
      }
      if (sub === 'new') {
        const ttl = opt('--expires') ? parseDuration(opt('--expires')!) : undefined
        const inv = await store.create(more.join(' '), ttl)
        const link = await publishedLink(APP_ORIGIN, APP_PATH, id, inv)
        console.log(`zaproszenie „${inv.label}”${inv.expires ? ' do ' + when(inv.expires) : ' bez terminu'}:\n${link}`)
        if (rest.includes('--qr')) console.log('\n' + qrForTerminal(link))
        console.log('Kto je otworzy, zapuka - zobaczysz to w onchato-cli chat (/knocks, /accept N).')
        break
      }
      if (sub === 'qr') { const inv = pick(more[0]); console.log(qrForTerminal(await publishedLink(APP_ORIGIN, APP_PATH, id, inv))); break }
      if (sub === 'revoke') {
        const inv = pick(more[0])
        await store.revoke(inv.id)
        console.log(`wycofano „${inv.label}” - nikt nie jest o tym informowany, nowe pukanie już nie dotrze`)
        break
      }
      die(usage)
      break
    }
    case 'add': {
      // An invite (link, fragment or bare code) first, through the app's own parser;
      // a raw key only as the explicit two-argument form.
      const inv = args[0] ? inviteFromPaste(args[0]) : null
      // A contact meets only inside one network: a link from another one is
      // refused here rather than saved as a contact that can never be reached.
      if (inv && inviteNetwork(inv) !== NETWORK) die(`to zaproszenie jest z sieci "${inviteNetwork(inv)}", a ten klient dziala w sieci "${NETWORK}" - kontakt z innej sieci nigdy sie nie spotka`)
      // A running daemon holds this identity's session: the contact goes in
      // THROUGH it (live, no restart, its knocks repeat until accepted) - a
      // second session here would close both (one identity, one session).
      const dsock = inv ? await connectDaemon() : null
      if (inv && dsock) {
        console.log(`kontakt:  ${opt('--name') ?? inv.name}\nodcisk:   ${await fingerprint(inv.pub)}\nPorównaj odcisk z tym, co ta osoba podała Ci innym kanałem (rozmowa, telefon).`)
        if (!await confirm('Zapisać?')) { dsock.end(); die('nie zapisano') }
        const r = await ask(dsock, { op: 'add', link: args[0], name: opt('--name'), note: opt('--note') })
        dsock.end()
        if (!r.ok) die(r.error)
        if (r.status === 'known') { console.log(`ten klucz już masz: ${r.name} (${r.fp})`); break }
        console.log(`zapisano kontakt ${r.name} (przez demona)`)
        if (r.knock !== undefined) console.log(r.knock === 0
          ? `zapukano, ale nikt teraz nie słucha tego zaproszenia - demon puka co 90 s, aż ${r.name} przyjmie`
          : `zapukano do ${r.name} - demon puka dalej co 90 s, aż przyjmie`)
        if (r.reply) console.log(`Odeślij ${r.name} swój link (już oznaczony jako odpowiedź):\n${r.reply}`)
        break
      }
      if (inv) {
        const name = opt('--name') ?? inv.name
        const { id, contacts, store, names, base } = await signIn(kv)
        if (inv.pub === id.pub) die('to Twój własny klucz')
        const known = (await contacts.list()).find((c) => c.pub === inv.pub)
        if (known) { console.log(`ten klucz już masz: ${known.name} (${await fingerprint(inv.pub)})`); break }
        console.log(`kontakt:  ${name}\nodcisk:   ${await fingerprint(inv.pub)}\nPorównaj odcisk z tym, co ta osoba podała Ci innym kanałem (rozmowa, telefon).`)
        if (!await confirm('Zapisać?')) die('nie zapisano')
        await contacts.add(name, inv.pub, false)
        await new Promise((r) => setTimeout(r, 150)) // the book's seal follows the write
        console.log(`zapisano kontakt ${name}`)
        // Until they hold our key too, neither side can compute the pair topic.
        if (inv.inbox && inv.key) {
          // An invite that answers itself: knock on its inbox with our key. The
          // app's waiting record keeps the client knocking until they accept.
          const raw = inboxSecretBytes(inv)!
          const session = await startSession(id, { relay: relayList(kv)[0], relays: relayList(kv), transport: 'light', networkId: NETWORK, peerKey: await peerKeyOf(kv, base, names) })
          let reach: number | null = null
          try { reach = await session.knock(raw, inv.key, { name: id.handle, note: opt('--note') }) } finally { await session.close().catch(() => {}) }
          const waiting = await store.waiting()
          waiting.set(inv.pub, { inbox: inv.inbox, key: inv.key, name, since: Date.now(), note: opt('--note') } as Waiting)
          await store.saveWaiting(waiting)
          console.log(reach === 0
            ? `zapukano, ale nikt teraz nie słucha tego zaproszenia - onchato-cli chat będzie pukać co 90 s, aż ${name} przyjmie`
            : `zapukano do ${name} - gdy przyjmie, zobaczysz go/ją online (onchato-cli chat)`)
        } else if (!inv.reply) {
          console.log(`Odeślij ${name} swój link (już oznaczony jako odpowiedź):\n${inviteLink(APP_ORIGIN, APP_PATH, { pub: id.pub, name: id.handle, reply: true })}`)
        }
        break
      }
      const [name, pub] = args
      if (!name || !pub) die('użycie: add <link|kod> [--name n]  albo  add <nazwa> <kluczB64>')
      let raw: Uint8Array
      try { raw = unb64(pub) } catch { die('to nie jest ani zaproszenie, ani klucz base64') }
      if (raw!.length !== 32) die('klucz publiczny ma 32 bajty (base64)')
      await (await signIn(kv)).contacts.add(name, pub, false)
      await new Promise((r) => setTimeout(r, 150))
      console.log(`zapisano kontakt ${name} (${await fingerprint(pub)})`)
      break
    }
    case 'verify': {
      const [name, ...said] = args
      if (!name) die('użycie: verify <nazwa> [--qr] [<numer albo kod onchato-sn1:...>]')
      const { id, contacts } = await signIn(kv)
      const c = (await contacts.list()).find((x) => x.name === name)
      if (!c) die(`nie ma kontaktu ${name}`)
      const n = await safetyNumber(unb64(id.pub), unb64(c!.pub))
      const g = safetyGroups(n)
      console.log(`Numer bezpieczeństwa ${id.handle} - ${name} (u obojga identyczny):\n  ${g.slice(0, 4).join(' ')}\n  ${g.slice(4, 8).join(' ')}\n  ${g.slice(8).join(' ')}`)
      if (rest.includes('--qr')) console.log('\n' + qrForTerminal(safetyQr(n)))
      if (said.length) {
        const text = said.join(' ')
        const theirs = parseSafetyQr(text) ?? text.replace(/\s+/g, '')
        if (!/^\d{60}$/.test(theirs)) die('podany numer nie ma 60 cyfr')
        if (theirs === n) console.log(`\u2713 zgodny - klucz ${name} jest ten sam u was obojga`)
        else { console.error(`\u2717 NIEZGODNY - to nie jest klucz, który masz dla ${name}. Nie piszcie nic poufnego, dopóki tego nie wyjaśnicie.`); process.exit(4) }
      }
      break
    }
    case 'chat': {
      if (!process.stdin.isTTY || !process.stdout.isTTY) die('klient interaktywny wymaga terminala')
      const { id, contacts, kind, store, names, base } = await signIn(kv)
      const stdin = process.stdin
      await runClient({
        id, kind, contacts, store, vault: { kv, base, names }, relays: relayList(kv), openFirst: args[0], debug: rest.includes('--debug'),
        peerKey: await peerKeyOf(kv, base, names),
        transport: rest.includes('--libp2p') ? 'libp2p' : 'light', networkId: NETWORK,
        io: {
          out: process.stdout,
          onInput: (cb) => { stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', (d) => cb(String(d))) },
          onResize: (cb) => { process.stdout.on('resize', cb) },
          exit: (code) => { try { stdin.setRawMode(false) } catch {} ; process.exit(code) },
        },
      })
      break
    }
    case 'send': {
      const [to, ...words] = args
      let text = words.join(' ')
      // Standard input only when asked for with '-': guessing from a missing
      // argument would hang a script whose stdin never closes.
      if (text === '-') { let b = ''; for await (const c of process.stdin) b += c; text = b.replace(/\n+$/, '') }
      if (!to || !text) die('użycie: send <kontakt|grupa> <tekst | ->  [--wait sekundy] [--json]')
      const waitMs = Number(opt('--wait', '20')) * 1000
      const out = (r: any) => {
        if (rest.includes('--json')) console.log(JSON.stringify(r))
        else if (r.status === 'delivered') console.log(`doręczono do ${r.to} (${r.ms} ms)`)
        else if (r.status === 'sent') console.log(`wysłano do grupy ${r.to} (grupy nie potwierdzają doręczenia)`)
        else if (r.status === 'merged') console.error(`połączono z czekającą wiadomością do ${r.to} o tym samym kluczu - wyjdzie jedna`)
        else console.error(r.via === 'daemon'
          ? `${r.to} nie potwierdził(a) w ${waitMs / 1000} s - wiadomość czeka w demonie (na dysku) i wyjdzie, gdy będzie online`
          : `${r.to} nie potwierdził(a) w ${waitMs / 1000} s - bez demona wiadomość NIE czeka (onchato-cli daemon)`)
        process.exit(r.status === 'delivered' || r.status === 'sent' ? 0 : 3)
      }
      const sock = await connectDaemon()
      if (sock) {
        const ttl = opt('--ttl') ? parseDuration(opt('--ttl')!) : undefined
        const r = await ask(sock, { op: 'send', to, text, wait: waitMs, ttl, key: opt('--key') })
        sock.end()
        if (!r.ok) die(r.error)
        out({ ...r, via: 'daemon' })
      }
      const { id, contacts, names, base } = await signIn(kv)
      const hub = new Hub({ id, contacts, relays: relayList(kv), networkId: NETWORK, vault: { kv, base, names }, peerKey: await peerKeyOf(kv, base, names) })
      await hub.start()
      try { out({ ...(await hub.send(to, text, waitMs)), via: 'direct' }) } finally { await hub.close() }
      break
    }
    case 'send-file': {
      const [to, file] = args
      if (!to || !file) die('użycie: send-file <kontakt> <plik> [--wait sekundy] [--json]')
      const path = resolve(file)
      if (!existsSync(path)) die(`nie ma pliku ${file}`)
      const waitMs = Number(opt('--wait', '20')) * 1000
      const out = (r: any) => {
        if (rest.includes('--json')) console.log(JSON.stringify(r))
        else if (r.status === 'delivered') console.log(`plik ${r.name} doręczony do ${r.to} (${r.ms} ms) - ma ok. 5 min na pobranie`)
        else console.error(`${r.to} nie potwierdził(a) w ${waitMs / 1000} s - plik leży w magazynie ok. 5 min; pliki nie czekają w kolejce`)
        process.exit(r.status === 'delivered' ? 0 : 3)
      }
      const sock = await connectDaemon()
      if (sock) { const r = await ask(sock, { op: 'sendfile', to, path, wait: waitMs }); sock.end(); if (!r.ok) die(r.error); out({ ...r, via: 'daemon' }) }
      const { id, contacts, names, base } = await signIn(kv)
      const hub = new Hub({ id, contacts, relays: relayList(kv), networkId: NETWORK, vault: { kv, base, names }, peerKey: await peerKeyOf(kv, base, names) })
      await hub.start()
      try { out({ ...(await hub.sendFile(to, path, waitMs)), via: 'direct' }) } finally { await hub.close() }
      break
    }
    case 'get': {
      const [fid] = args
      if (!fid) die('użycie: get <id> [--dir <katalog>]  (id z onchato-cli listen)')
      const sock = await connectDaemon()
      if (!sock) die('get działa przez demona (pliki zna ten, kto je odebrał) - bez demona użyj listen --save-files')
      const r = await ask(sock!, { op: 'get', id: fid, dir: opt('--dir') ? resolve(opt('--dir')!) : undefined }); sock!.end()
      if (!r.ok) die(r.error)
      console.log(`zapisano ${r.path}`)
      break
    }
    case 'listen': {
      const json = rest.includes('--json')
      const show = (e: HubEvent) => {
        if (json) { console.log(JSON.stringify(e)); return }
        if (e.t === 'msg') console.log(`${new Date(e.ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} ${e.group ? `[${e.group}] ` : ''}<${e.from}> ${e.text}`)
        if (e.t === 'group') console.log(`-!- grupa „${e.name}” (${e.members} osób)${e.how === 'invite' ? ' - dołączono' : ''}`)
        if (e.t === 'presence') console.log(`-!- ${e.from} ${e.state === 'online' ? 'online' : 'offline'}`)
        if (e.t === 'file') console.log(`${new Date(e.ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} <${e.from}> plik ${e.name} (${humanSize(e.size)}) - onchato-cli get ${e.id.slice(0, 8)}`)
      }
      // --save-files: every incoming file is fetched at once (the store keeps it ~5 min).
      const saveDir = opt('--save-files') ? resolve(opt('--save-files')!) : null
      const saved = (name: string, path: string) => json ? console.log(JSON.stringify({ t: 'saved', name, path })) : console.log(`-!- zapisano ${path}`)
      const failed = (name: string, err: string) => json ? console.log(JSON.stringify({ t: 'save-failed', name, error: err })) : console.error(`-!- nie zapisano ${name}: ${err}`)
      const sock = await connectDaemon()
      if (sock) {
        sock.on('data', lineReader(async (o) => {
          if (!o.t) return
          show(o as HubEvent)
          if (o.t === 'file' && saveDir) {
            const s2 = await connectDaemon(); if (!s2) return
            const r = await ask(s2, { op: 'get', id: o.id, dir: saveDir }); s2.destroy()
            r.ok ? saved(o.name, r.path) : failed(o.name, r.error)
          }
        }))
        sock.on('close', () => process.exit(0))
        sock.write(JSON.stringify({ op: 'listen' }) + '\n')
        await new Promise(() => {})
      }
      const { id, contacts, names, base } = await signIn(kv)
      const hub = new Hub({ id, contacts, relays: relayList(kv), networkId: NETWORK, vault: { kv, base, names }, peerKey: await peerKeyOf(kv, base, names) })
      hub.on(show)
      if (saveDir) hub.on((e) => { if (e.t === 'file') hub.getFile(e.id, saveDir).then((p) => saved(e.name, p), (err) => failed(e.name, err?.message ?? String(err))) })
      await hub.start()
      const stop = async () => { await hub.close(); process.exit(0) }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      await new Promise(() => {})
      break
    }
    case 'queue': {
      const sock = await connectDaemon()
      if (!sock) die('demon nie działa - kolejka istnieje tylko w demonie (onchato-cli daemon)')
      const r = await ask(sock!, { op: 'queue' }); sock!.end()
      if (rest.includes('--json')) { console.log(JSON.stringify(r.entries)); break }
      if (!r.entries.length) { console.log('(kolejka pusta)'); break }
      for (const e of r.entries) console.log(`  do ${String(e.to).padEnd(12)} od ${e.age_s}s, ważne jeszcze ${Math.round(e.expires_in_s / 60)} min${e.key ? ' · klucz ' + e.key : ''}${e.merged ? ` · +${e.merged} połączonych` : ''}\n     ${e.text.slice(0, 100)}`)
      break
    }
    case 'knocks': case 'accept': case 'ignore': {
      // Knocks are held by the session that heard them: the daemon (or `chat`, with /knocks).
      const sock = await connectDaemon()
      if (!sock) die('demon nie działa - pukanie odbiera onchato-cli daemon albo onchato-cli chat (/knocks)')
      if (cmd === 'knocks') {
        const r = await ask(sock!, { op: 'knocks' }); sock!.end()
        if (!r.ok) die(r.error)
        if (!r.knocks.length) { console.log('nikt nie puka'); break }
        for (const k of r.knocks) console.log(`  ${k.n}) ${k.name} · odcisk ${k.fp} · zaproszenie „${k.invite}”${k.note ? ' · „' + k.note + '”' : ''}`)
        break
      }
      const n = Number(args[0])
      if (!Number.isInteger(n) || n < 1) { sock!.end(); die(`użycie: ${cmd} <nr z onchato-cli knocks>`) }
      const r = await ask(sock!, { op: cmd, n }); sock!.end()
      if (!r.ok) die(r.error)
      console.log(cmd === 'accept' ? `dodano ${r.name} (${r.fp})` : `zignorowano ${r.name} (${r.fp}) - kolejne pukanie z tego klucza nie pojawi się`)
      break
    }
    case 'daemon': {
      const { id, contacts, kind, names, base } = await signIn(kv)
      const say = (m: string) => console.log(`[onchato] ${m}`)
      const hub = new Hub({ id, contacts, relays: relayList(kv), networkId: NETWORK, vault: { kv, base, names }, peerKey: await peerKeyOf(kv, base, names), log: rest.includes('--debug') ? say : undefined, hem: kind === 'HEM', invites: true })
      hub.on((e) => {
        if (e.t === 'link') say(`łącze: ${e.state}`)
        // Loud: somebody is at the door, and the name is only a claim.
        if (e.t === 'knock') say(`${e.name} puka (zaproszenie „${e.invite}”) · odcisk ${e.fp}${e.note ? ` · „${e.note}”` : ''} - onchato-cli accept ${e.n} | ignore ${e.n}`)
        if (e.t === 'contact') say(e.how === 'accepted' ? `${e.name} przyjął(a) nasze pukanie (${e.fp})` : `nowy kontakt: ${e.name} (${e.fp})`)
        if (e.t === 'presence') say(`${e.from}: ${e.state}`)
        // That something arrived, never what: the journal is not the conversation.
        if (e.t === 'msg') say(`wiadomość od ${e.from}${e.group ? ` w ${e.group}` : ''} (${e.text.length} znaków)`)
        if (e.t === 'file') say(`plik od ${e.from}${e.group ? ` w ${e.group}` : ''} (${e.size} B)`)
      })
      await hub.start()
      if (hub.desk?.listening()) say(`słucham ${hub.desk.listening()} zaproszeń - pukanie: onchato-cli knocks`)
      if (hub.desk?.knockingOn().length) say(`pukam do: ${hub.desk.knockingOn().join(', ')} (co 90 s, aż przyjmą)`)
      const queue = new Queue({ hub, kv, base, names, log: say })
      await queue.load()
      const path = socketPath()
      const srv = await serve(hub, path, say, queue)
      say(`${id.handle} (${kind}) · ${hub.contactList.length} kontaktów · gniazdo ${path}`)
      const stop = async () => { say('zatrzymuję'); queue.stop(); await queue.save(); srv.close(); try { unlinkSync(path) } catch {} ; await hub.close(); process.exit(0) }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      await new Promise(() => {})
      break
    }
    default:
      console.log('użycie: onchato-cli profile new|list|import|export · hem new <nazwa> --hem <url> · send · send-file · listen · get · daemon · queue · knocks · accept N · ignore N · whoami · pubkey · contacts · invite [--qr]\n         add <link|kod> | add <nazwa> <klucz> · verify <nazwa> [--qr] [numer] · chat <nazwa>\n         [--profile <nazwa> | --hem <url> [--handle h]] [--password p]')
  }
} catch (e: any) {
  // Nodes refuse the sanctioned regions with 451 (GEOBLOKADA.md), and a refused
  // WebSocket only says "failed": ask a node, so the message says why.
  if (await regionBlocked(relayList(kv).map(hostOf).filter((h): h is string => !!h)).catch(() => false)) die(REGION_MSG)
  die(e?.message ?? String(e))
}
