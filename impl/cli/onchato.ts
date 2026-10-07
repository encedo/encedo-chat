#!/usr/bin/env node
/**
 * onchato.ts - the terminal client (CLI-PLAN.md, stage 1: the foundation).
 *
 *   onchato profile new <name>                 a software identity, sealed (browser format)
 *   onchato profile list
 *   onchato hem new <name> --hem <url>          a new onchato identity on a HEM (sign-in never creates one)
 *   onchato profile import <file.ocmig>        the app's "move profile" file
 *   onchato profile export <name> <file>
 *   onchato whoami | pubkey | contacts
 *   onchato invite [--qr]                     my identity link (and the code, drawn in the terminal)
 *   onchato invites [new [label] [--expires 24h] [--qr] | qr <n> | revoke <n>]
 *                                              invites that answer themselves: whoever opens one knocks,
 *                                              and the client (onchato chat) shows the knock to accept
 *   onchato add <link|code> [--name n] [--yes] a contact from an invite - fingerprint shown, confirmed
 *   onchato add <name> <pubB64>                a contact by raw key
 *   onchato verify <name> [--qr] [<number>]    the pair's safety number; compare one read out to you
 *   onchato chat [<name>] [--debug]           the irssi-style client (windows, Alt+N, /help)
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
import { readFileSync } from 'node:fs'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'
import { hemContactBook, mergedContactBook, localOnlyManager, type ContactManager, type Identity } from '../lib/core.ts'
import { BadPassword } from '../lib/profile.ts'
import { inviteFromPaste, inviteLink } from '../lib/invite.ts'
import { safetyNumber, safetyGroups, safetyQr, parseSafetyQr } from '../lib/safety.ts'
import { qrForTerminal } from './termqr.ts'
import { fingerprint } from './fp.ts'
import { InviteStore, publishedLink, parseDuration, expired, type Waiting } from './invites.ts'
import { startSession } from '../lib/core.ts'
import { inboxSecretBytes } from '../lib/invite.ts'
import { createInterface } from 'node:readline/promises'

/** Where invite links point (app.ts CANONICAL_ORIGIN/PATH): the CLI has no address bar either. */
const APP_ORIGIN = 'https://app.onchato.com', APP_PATH = '/'
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
function relayList(kv: FileKV): string[] {
  try {
    const mine = JSON.parse(kv.get('ec-nodes') ?? 'null')
    const on = Array.isArray(mine) ? mine.filter((n: any) => n?.enabled !== false && typeof n?.addr === 'string').map((n: any) => n.addr) : []
    if (on.length) return on
  } catch {}
  const pub = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8'))
  return pub.nodes.map((n: any) => n.addr)
}
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def }
const args = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && opt(rest[i - 1]) === a))
const die = (msg: string): never => { console.error('onchato: ' + msg); process.exit(1) }

/** A secret from the flag, the environment, or a masked prompt (stdin when piped). */
async function secret(prompt: string, envName = 'ONCHATO_PASSWORD'): Promise<string> {
  const flag = opt('--password'); if (flag) return flag
  if (process.env[envName]) return process.env[envName]!
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
async function signIn(kv: FileKV): Promise<{ id: Identity; contacts: ContactManager; kind: string; store: InviteStore }> {
  const hemUrl = opt('--hem')
  if (hemUrl) {
    const { id, hem, kid } = await hemSignIn(hemUrl, await secret('Hasło HEM: '), opt('--handle'), chooseIdentity)
    const key = await identityKey(id.pub, kid)
    const local = await openLocalBook(key, kv, await cacheBaseOf(id, key, kv))
    if (local.verdict === 'tampered') console.error('onchato: UWAGA - lokalna książka kontaktów nie przeszła weryfikacji podpisu (pokazuję tylko kontakty z HEM)')
    return { id, kind: 'HEM', store: new InviteStore(kv, await cacheBaseOf(id, key, kv), key), contacts: mergedContactBook(hemContactBook(hem, kid), local.verdict === 'tampered' ? emptyBook() : local.book) }
  }
  const names = listProfiles(kv)
  const name = opt('--profile') ?? (names.length === 1 ? names[0] : undefined)
  if (!name) die(names.length ? `kilka profili (${names.join(', ')}) - wybierz --profile <nazwa>` : 'brak profilu - onchato profile new <nazwa> albo profile import <plik>')
  let id: Identity
  try { id = await openProfile(kv, name!, await secret(`Hasło profilu ${name}: `)) }
  catch (e) { die(e instanceof BadPassword ? 'złe hasło' : (e as Error).message) }
  const key = await identityKey(id!.pub)
  const local = await openLocalBook(key, kv, await cacheBaseOf(id!, key, kv))
  if (local.verdict === 'tampered') die('książka kontaktów nie przeszła weryfikacji podpisu - ktoś zmienił ' + kv.path + ' (nic nie nadpisuję)')
  return { id: id!, kind: 'software', store: new InviteStore(kv, await cacheBaseOf(id!, key, kv), key), contacts: localOnlyManager(local.book) }
}
const emptyBook = () => ({ list: async () => [], add: async () => { throw new Error('książka zablokowana') }, remove: async () => {}, rename: async () => {} })

const kv = fileKV()
try {
  switch (cmd) {
    case 'profile': {
      const [sub, a, b] = args
      if (sub === 'list') { const n = listProfiles(kv); console.log(n.length ? n.join('\n') : '(brak profili)'); break }
      if (sub === 'new') {
        if (!a) die('użycie: profile new <nazwa>')
        const pw = await secret('Nowe hasło: ')
        if (!opt('--password') && !process.env.ONCHATO_PASSWORD && pw !== await secret('Powtórz hasło: ')) die('hasła się różnią')
        const id = await createProfile(kv, a, pw)
        console.log(`profil ${a} utworzony\nklucz:  ${id.pub}\nodcisk: ${await fingerprint(id.pub)}`)
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
      console.log(`tożsamość: ${id.handle} (${kind})\nklucz:     ${id.pub}\nodcisk:    ${await fingerprint(id.pub)}`)
      break
    }
    case 'pubkey': console.log((await signIn(kv)).id.pub); break
    case 'contacts': {
      const list = await (await signIn(kv)).contacts.list()
      console.log(list.length ? (await Promise.all(list.map(async (c) => `  ${c.name.padEnd(16)} ${await fingerprint(c.pub)}  ${c.source}`))).join('\n') : '(brak kontaktów - onchato add <nazwa> <klucz>)')
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
      const { id, store } = await signIn(kv)
      const list = await store.invites()
      const pick = (n: string) => list[Number(n) - 1] ?? die(`nie ma zaproszenia nr ${n} (onchato invites)`)
      const when = (t: number) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      if (!sub || sub === 'list') {
        if (!list.length) { console.log('(brak zaproszeń - onchato invites new <etykieta>)'); break }
        list.forEach((inv, i) => console.log(`  ${i + 1}) ${inv.label.padEnd(16)} od ${when(inv.created)}  ${inv.expires ? (expired(inv) ? 'WYGASŁO' : 'do ' + when(inv.expires)) : 'bez terminu'}\n     ${publishedLink(APP_ORIGIN, APP_PATH, id, inv)}`))
        console.log('Pukanie widać w kliencie (onchato chat) - zaproszenie słucha tylko, gdy klient działa.')
        break
      }
      if (sub === 'new') {
        const ttl = opt('--expires') ? parseDuration(opt('--expires')!) : undefined
        const inv = await store.create(more.join(' '), ttl)
        const link = publishedLink(APP_ORIGIN, APP_PATH, id, inv)
        console.log(`zaproszenie „${inv.label}”${inv.expires ? ' do ' + when(inv.expires) : ' bez terminu'}:\n${link}`)
        if (rest.includes('--qr')) console.log('\n' + qrForTerminal(link))
        console.log('Kto je otworzy, zapuka - zobaczysz to w onchato chat (/knocks, /accept N).')
        break
      }
      if (sub === 'qr') { const inv = pick(more[0]); console.log(qrForTerminal(publishedLink(APP_ORIGIN, APP_PATH, id, inv))); break }
      if (sub === 'revoke') {
        const inv = pick(more[0])
        await store.revoke(inv.id)
        console.log(`wycofano „${inv.label}” - nikt nie jest o tym informowany, nowe pukanie już nie dotrze`)
        break
      }
      die('użycie: invites [list] | new [etykieta] [--expires 24h] [--qr] | qr <nr> | revoke <nr>')
      break
    }
    case 'add': {
      // An invite (link, fragment or bare code) first, through the app's own parser;
      // a raw key only as the explicit two-argument form.
      const inv = args[0] ? inviteFromPaste(args[0]) : null
      if (inv) {
        const name = opt('--name') ?? inv.name
        const { id, contacts, store } = await signIn(kv)
        if (inv.pub === id.pub) die('to Twój własny klucz')
        const known = (await contacts.list()).find((c) => c.pub === inv.pub)
        if (known) { console.log(`ten klucz już masz: ${known.name} (${await fingerprint(inv.pub)})`); break }
        console.log(`kontakt:  ${name}\nodcisk:   ${await fingerprint(inv.pub)}\nPorównaj odcisk z tym, co ta osoba podała Ci innym kanałem (rozmowa, telefon).`)
        if (!await confirm('Zapisać?')) die('nie zapisano')
        await contacts.add(name, inv.pub, false)
        await new Promise((r) => setTimeout(r, 150)) // the book's signature follows the write
        console.log(`zapisano kontakt ${name}`)
        // Until they hold our key too, neither side can compute the pair topic.
        if (inv.inbox) {
          // An invite that answers itself: knock on its inbox with our key. The
          // app's waiting record keeps the client knocking until they accept.
          const raw = inboxSecretBytes(inv)!
          const session = await startSession(id, { relay: relayList(kv)[0], relays: relayList(kv), transport: 'light' })
          let reach: number | null = null
          try { reach = await session.knock(raw, inv.pub, { name: id.handle, note: opt('--note') }) } finally { await session.close().catch(() => {}) }
          const waiting = await store.waiting()
          waiting.set(inv.pub, { inbox: inv.inbox, name, since: Date.now(), note: opt('--note') } as Waiting)
          await store.saveWaiting(waiting)
          console.log(reach === 0
            ? `zapukano, ale nikt teraz nie słucha tego zaproszenia - onchato chat będzie pukać co 90 s, aż ${name} przyjmie`
            : `zapukano do ${name} - gdy przyjmie, zobaczysz go/ją online (onchato chat)`)
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
      const { id, contacts, kind, store } = await signIn(kv)
      const stdin = process.stdin
      await runClient({
        id, kind, contacts, store, relays: relayList(kv), openFirst: args[0], debug: rest.includes('--debug'),
        transport: rest.includes('--libp2p') ? 'libp2p' : 'light',
        io: {
          out: process.stdout,
          onInput: (cb) => { stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', (d) => cb(String(d))) },
          onResize: (cb) => { process.stdout.on('resize', cb) },
          exit: (code) => { try { stdin.setRawMode(false) } catch {} ; process.exit(code) },
        },
      })
      break
    }
    default:
      console.log('użycie: onchato profile new|list|import|export · hem new <nazwa> --hem <url> · whoami · pubkey · contacts · invite [--qr]\n         add <link|kod> | add <nazwa> <klucz> · verify <nazwa> [--qr] [numer] · chat <nazwa>\n         [--profile <nazwa> | --hem <url> [--handle h]] [--password p]')
  }
} catch (e: any) { die(e?.message ?? String(e)) }
