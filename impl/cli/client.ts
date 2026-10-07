/**
 * client.ts - the irssi-style client (CLI-PLAN.md stage 3): windows over one
 * session, like the app - one transport, many rooms, a presence watch for every
 * contact, and an incoming conversation opening in a background window rather
 * than in your face.
 *
 * Input and output are injected (`Io`), so a test drives it with a fake
 * terminal; `onchato` passes process.stdin/stdout.
 */

import { startSession, type ClientSession, type Conversation, type ContactManager, type Contact, type Identity } from '../lib/core.ts'
import { localHHMM } from '../lib/time.ts'
import { safetyNumber, safetyGroups } from '../lib/safety.ts'
import { inviteLink } from '../lib/invite.ts'
import { Windows, type Win } from './windows.ts'
import { decodeKeys, LineEditor } from './keys.ts'
import { Screen, statusLine, SGR, type Out } from './tui.ts'
import { expired, type InviteStore, type PubInvite } from './invites.ts'
import { inboxSecretBytes } from '../lib/invite.ts'
import { prepareFile, saveFile, humanSize, downloadDir } from './files.ts'
import type { FileMeta } from '../lib/envelope.ts'
import { Groups, type GroupInfo } from './groups.ts'
import { mentionsPub, splitByMentions, resolveMention } from '../lib/mentions.ts'
import { fingerprint } from './fp.ts'
import type { KV } from '../lib/migrate.ts'

export interface Io {
  out: Out
  /** Raw key chunks as strings. */
  onInput(cb: (chunk: string) => void): void
  onResize?(cb: () => void): void
  exit(code: number): void
}

export interface ClientOpts {
  id: Identity
  kind: string                  // 'HEM' | 'software', for the status line
  contacts: ContactManager
  relays: string[]              // failover order; [0] is preferred
  transport?: 'light' | 'libp2p'
  /** Open this contact's window at start (onchato chat <name>). */
  openFirst?: string
  debug?: boolean
  /** Published invites, pending knocks, ignore list (the app's sealed records). */
  store?: InviteStore
  /** Where group state is sealed (the store, its §10 key, the identity's KID). */
  vault?: { kv: KV; base: Uint8Array | null; kid: string }
  io: Io
}

/** Under a minute would be rude to the relay; over a few makes the other side wait (the app's value). */
const KNOCK_EVERY_MS = 90_000

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const nodeName = (addr: string) => addr.match(/dns4\/([^./]+)/)?.[1] ?? addr.slice(0, 12)
const APP_ORIGIN = 'https://app.onchato.com'

/** `win` is null for a 1:1 opened only to carry group keys: it gets a window when
 *  there is something to show, not for every member of every group. */
interface Room { contact: Contact; conv: Conversation | null; win: Win | null; secure: boolean; lastRecvId: string | null; lastFile: string | null }

export async function runClient(o: ClientOpts): Promise<{ session: ClientSession; quit: () => Promise<void>; windows: Windows }> {
  const w = new Windows()
  const sc = new Screen(o.io.out)
  const ed = new LineEditor()
  const rooms = new Map<string, Room>()   // contact pub -> room
  const online = new Set<string>()
  let link: boolean | null = null
  let node = nodeName(o.relays[0])
  // Declared before the session: its callbacks (a group invitation, a file) can
  // fire before the code that fills these runs.
  let groups: Groups | null = null
  const files = new Map<string, FileMeta>()   // short id -> meta (with its key: memory only)

  const t = (ts = Date.now()) => SGR.grey + localHHMM(ts) + SGR.reset
  const sys = (s: string) => `${t()} ${SGR.grey}-!- ${s}${SGR.reset}`
  const warn = (s: string) => `${t()} ${SGR.red}-!- ${s}${SGR.reset}`

  const roomOf = (win: Win) => [...rooms.values()].find((r) => r.win === win)
  const repaintStatus = () => {
    const r = roomOf(w.current())
    const secure = w.current().kind === 'group' ? true : !!r?.secure
    sc.status(statusLine({ clock: localHHMM(Date.now()), me: o.id.handle, kind: o.kind, node, online: link, secure }, w))
    sc.input(`[${w.current().title}] `, ed.text, ed.cursor)
  }
  /** Print into window `n`; draw it now if it is on screen. */
  const print = (n: number, line: string, level: 'sys' | 'msg' | 'mention' = 'sys') => {
    w.print(n, line, level)
    if (n === w.active) sc.appendLine(line)
    repaintStatus()
  }
  const status = (line: string) => print(1, line)
  const switchTo = (n: number) => {
    if (!w.switchTo(n)) { status(warn(`nie ma okna ${n}`)); return }
    sc.drawWindow(w.current()); repaintStatus()
  }

  sc.start()
  status(sys(`onchato · ${o.id.handle} (${o.kind}) · łączę z ${node}…`))
  status(sys('Alt+1…9 albo /win N przełącza okna · /query <kontakt> · /list · /help'))

  const session = await startSession(o.id, {
    relay: o.relays[0], relays: o.relays, transport: o.transport ?? 'light',
    onLog: (m) => { if (o.debug) status(`${SGR.grey}${m}${SGR.reset}`) },
    onLink: (state) => {
      link = state === 'online' ? true : state === 'offline' ? false : null
      status(state === 'online' ? sys(`połączono z ${node}`) : state === 'reconnecting' ? warn('wznawiam połączenie z węzłem…') : warn('brak połączenia z węzłem'))
    },
    onRelay: (addr) => { node = nodeName(addr); status(sys(`węzeł: ${node}`)) },
    onGroupSkd: (from, skd) => { void groups?.onInvite(from, skd) },      // an invitation over a 1:1
    onGroupSkdReq: (from, req) => { void groups?.onSkdReq(from, req) },   // a member asking for our key
  })
  // onLink reports CHANGES; the state the session starts in is read once here,
  // or the status line would say "connecting" over a working link.
  {
    const ns = session.netStatus()
    if (link === null) link = ns.link === 'online' ? true : ns.link === 'offline' ? false : null
    if (ns.relay) node = nodeName(ns.relay)
    if (link) status(sys(`połączono z ${node}`))
  }

  /** Open (or return) the room for a contact, in its own window. */
  async function openRoom(c: Contact, show = true): Promise<Room> {
    const have = rooms.get(c.pub)
    if (have) { if (show && !have.win) have.win = w.open('query', c.pub, c.name); return have }
    const room: Room = { contact: c, conv: null, win: show ? w.open('query', c.pub, c.name) : null, secure: false, lastRecvId: null, lastFile: null }
    rooms.set(c.pub, room)
    /** Into this room's window; `make` opens one if it has none yet. */
    const out = (line: string, level: 'sys' | 'msg' | 'mention' = 'sys', make = false) => {
      if (!room.win && make) { room.win = w.open('query', c.pub, c.name); status(sys(`${c.name} pisze - okno ${room.win.n}`)) }
      if (room.win) print(room.win.n, line, level)
    }
    out(sys(`rozmowa z ${c.name} · czekam, aż będzie w pokoju…`))
    room.conv = await session.open({ pub: c.pub }, {
      onSecurity: (_peer, state) => {
        const was = room.secure
        room.secure = state === 'established' || (room.secure && state !== 'failed')
        if (room.secure && !was) out(sys(`${SGR.green}sesja zabezpieczona (EH-2)${SGR.reset}${SGR.grey}`))
        if (state === 'failed') out(warn('uzgadnianie klucza nie doszło do skutku - ponowi się samo'))
        repaintStatus()
      },
      onMessage: (_from, m) => {
        room.lastRecvId = m.id
        const line = m.body.startsWith('ACTION ')
          ? `${t(m.ts)} ${SGR.cyan}* ${c.name} ${m.body.slice(7)}${SGR.reset}`
          : `${t(m.ts)} ${SGR.cyan}${SGR.bold}<${c.name}>${SGR.reset} ${m.body}`
        out(line, 'msg', true)
      },
      onReaction: (_from, r) => out(`${t(r.ts)} ${SGR.cyan}* ${c.name} reaguje ${r.emoji}${SGR.reset}`, 'msg', true),
      onFile: (_from, f) => {
        // Kept by a short id; the key stays in memory, never on screen.
        const fid = f.id.slice(0, 4)
        files.set(fid, f as unknown as FileMeta); room.lastFile = fid
        out(`${t(f.ts)} ${SGR.cyan}${SGR.bold}<${c.name}>${SGR.reset} 📎 ${f.name} (${humanSize(f.size)})${f.body ? ' - ' + f.body : ''} ${SGR.grey}- /get ${fid}${SGR.reset}`, 'msg', true)
      },
      onPresence: (_peer, ev) => {
        if (ev === 'join') out(sys(`${c.name} w pokoju`))
        if (ev === 'leave') { out(sys(`${c.name} wyszedł/wyszła`)); room.secure = false; repaintStatus() }
      },
      onUndelivered: (mid) => out(warn(`nie doręczono wiadomości ${mid.slice(0, 6)}… - ${c.name} nie potwierdził(a)`), 'sys', true),
      onSessionTakenOver: () => {
        status(warn('ta tożsamość otworzyła się w drugim miejscu - obie sesje się zamykają (§9.1)'))
        setTimeout(() => void quit(), 1500)
      },
    })
    return room
  }

  // Presence for every contact; an incoming conversation opens in the background.
  const contactList = await o.contacts.list()
  let waiting = o.store ? await o.store.waiting() : new Map()
  const presence = {
    onOnline: (p: { pub: string }) => {
      // They announce, so they hold our key: a knock of ours was accepted.
      if (waiting.delete(p.pub)) {
        void o.store?.saveWaiting(waiting)
        const c = contactList.find((x) => x.pub === p.pub)
        print(1, sys(`${SGR.green}${c?.name ?? 'kontakt'} przyjął(a) Twoje pukanie${SGR.reset}${SGR.grey} - /query ${c?.name ?? ''}`), 'msg')
      }
      if (!online.has(p.pub)) { online.add(p.pub); repaintStatus(); groups?.onOnline(p.pub) }
    },
    onOffline: (p: { pub: string }) => { online.delete(p.pub) },
    onWantsConversation: (p: { pub: string }) => {
      const c = contactList.find((x) => x.pub === p.pub); if (!c || rooms.has(c.pub)) return
      status(sys(`${c.name} zaczyna rozmowę - okno ${w.open('query', c.pub, c.name).n}`))
      void openRoom(c)
    },
  }
  await session.watchContacts(contactList.map((c) => ({ pub: c.pub })), presence)

  // ---- groups (PROTOCOL.md §8; cli/groups.ts) ----------------------------------
  const fps = new Map<string, string>()
  const memberName = (pub: string) => pub === o.id.pub ? o.id.handle
    : contactList.find((c) => c.pub === pub)?.name ?? (fps.get(pub) ? fps.get(pub)!.slice(0, 11) + '…' : pub.slice(0, 8))
  const isContact = (pub: string) => contactList.some((c) => c.pub === pub)
  const groupWin = (g: GroupInfo) => w.open('group', g.gid, g.name)
  /** A group message as text: mentions shown by MY name for that key. */
  const showMentions = (text: string, g: GroupInfo) => splitByMentions(text).map((part) => {
    if (!part.mention) return part.text
    const pub = resolveMention(part.mention.hint, g.members)
    return pub ? `${SGR.magenta}@${memberName(pub)}${SGR.reset}` : part.text
  }).join('')
  const noteForeign = async (g: GroupInfo) => {
    const foreign = g.members.filter((p) => p !== o.id.pub && !isContact(p))
    for (const p of foreign) if (!fps.has(p)) fps.set(p, await fingerprint(p))
    if (foreign.length) print(groupWin(g).n, warn(`spoza Twoich kontaktów: ${foreign.map(memberName).join(', ')} - dopóki nie dodacie się nawzajem, nie zobaczycie swoich wiadomości w tej grupie`))
  }
  if (o.vault) {
    groups = new Groups({
      session, me: o.id.pub, ...o.vault, contacts: () => contactList,
      conv: async (pub) => { const c = contactList.find((x) => x.pub === pub); return c ? (await openRoom(c, false)).conv : null },
      handlers: {
        joined: (g, how) => {
          const win = groupWin(g)
          const line = how === 'invite' ? `dołączono do grupy „${g.name}” (${g.members.length} osób) - okno ${win.n}`
            : how === 'create' ? `utworzono grupę „${g.name}” - zaproszenia idą do członków (gdy są online)` : ''
          if (line) { status(sys(line)); print(win.n, sys(line)) }
          void noteForeign(g)
        },
        updated: (g, what) => { print(groupWin(g).n, sys(`grupa „${g.name}”: zmiana (${what}) - ${g.members.length} osób`)); void noteForeign(g) },
        message: (g, from, m) => {
          const me = mentionsPub(m.body, o.id.pub)
          print(groupWin(g).n, `${t(m.ts)} ${SGR.cyan}${SGR.bold}<${memberName(from)}>${SGR.reset} ${showMentions(m.body, g)}`, me ? 'mention' : 'msg')
        },
        file: (g, from, f) => {
          const fid = f.id.slice(0, 4); files.set(fid, f as unknown as FileMeta)
          print(groupWin(g).n, `${t(f.ts)} ${SGR.cyan}${SGR.bold}<${memberName(from)}>${SGR.reset} 📎 ${f.name} (${humanSize(f.size)}) ${SGR.grey}- /get ${fid}${SGR.reset}`, 'msg')
        },
        reaction: (g, from, r) => print(groupWin(g).n, `${t(r.ts)} ${SGR.cyan}* ${memberName(from)} reaguje ${r.emoji}${SGR.reset}`, 'msg'),
        log: (m) => { if (o.debug) status(`${SGR.grey}${m}${SGR.reset}`) },
      },
    })
    await groups.restore()
    if (groups.list().length) status(sys(`grupy: ${groups.list().map((g) => `„${g.name}” (okno ${groupWin(g).n})`).join(', ')}`))
  }
  const groupOf = (win: Win) => win.kind === 'group' ? groups?.get(win.key) ?? null : null

  // ---- invites that answer themselves (PROTOCOL.md §5.7-5.8) ----------------
  interface Knock { n: number; ik: string; name: string; note: string; fp: string; inv: PubInvite }
  let knocks: Knock[] = []
  let knockSeq = 0
  const inboxWatches = new Map<string, { stop(): void }>()
  const knownKnocks = new Set<string>()
  const watchInvites = async () => {
    if (!o.store) return
    const list = await o.store.invites()
    for (const [id, wt] of inboxWatches) if (!list.some((i) => i.id === id && !expired(i))) { wt.stop(); inboxWatches.delete(id) }
    for (const inv of list) {
      if (inboxWatches.has(inv.id) || expired(inv)) continue
      const raw = inboxSecretBytes({ pub: '', name: '', inbox: inv.secret }); if (!raw) continue
      inboxWatches.set(inv.id, session.watchInbox(raw, {
        onKnock: (k) => void (async () => {
          const ik = btoa(String.fromCharCode(...k.ik))
          if (knocks.some((x) => x.ik === ik && x.inv.id === inv.id)) return       // a re-knock while waiting
          const known = contactList.find((c) => c.pub === ik)
          if (known) {
            if (knownKnocks.has(ik + inv.id)) return   // the app re-knocks every 90 s; say it once
            knownKnocks.add(ik + inv.id)
            // Said, not swallowed: silence here made a working invite look broken
            // (2026-10-07 - the phone already held this key).
            print(1, sys(`${known.name} zapukał(a) do zaproszenia „${inv.label}”, ale jest już w Twoich kontaktach - /query ${known.name}`), 'msg')
            return
          }
          const fp = await fingerprint(ik)
          if ((await o.store!.ignored()).some((r) => r.fp === fp)) return
          if (knocks.some((x) => x.ik === ik && x.inv.id === inv.id)) return       // raced the awaits
          const kn: Knock = { n: ++knockSeq, ik, name: (k.name || 'bez nazwy').slice(0, 64), note: k.note ?? '', fp, inv }
          knocks.push(kn)
          // Loud on purpose: somebody is at the door, and the name is only a claim.
          print(1, `${t()} ${SGR.magenta}${SGR.bold}-!- ${kn.name} puka${SGR.reset} ${SGR.grey}(zaproszenie „${inv.label}”) · odcisk ${fp}${kn.note ? ' · „' + kn.note + '”' : ''} - /accept ${kn.n} · /ignore ${kn.n}${SGR.reset}`, 'mention')
        })(),
      }))
    }
  }
  await watchInvites()
  if (inboxWatches.size) status(sys(`słucham ${inboxWatches.size} zaproszeń (pukanie pojawi się tutaj)`))
  const invTimer = setInterval(() => void watchInvites(), 30_000); (invTimer as any).unref?.()

  // Knocks we are still making (onchato add <invite>), until they accept.
  const knockAll = () => {
    for (const [pub, wt] of waiting) {
      const raw = inboxSecretBytes({ pub: '', name: '', inbox: wt.inbox }); if (!raw) continue
      void session.knock(raw, pub, { name: o.id.handle, note: wt.note }).catch(() => {})
    }
  }
  if (waiting.size) { knockAll(); status(sys(`pukam do: ${[...waiting.values()].map((x) => x.name).join(', ')} (co 90 s, aż przyjmą)`)) }
  const knockTimer = setInterval(() => { if (waiting.size) knockAll() }, KNOCK_EVERY_MS); (knockTimer as any).unref?.()

  /** A contact by its number on /list or by name (case-insensitive). */
  const findContact = (q: string) => {
    const n = Number(q)
    if (Number.isInteger(n) && n >= 1 && n <= contactList.length && String(n) === q.trim()) return contactList[n - 1]
    return contactList.find((c) => c.name.toLowerCase() === q.toLowerCase())
  }
  const showList = () => {
    if (!contactList.length) { print(w.active, sys('brak kontaktów - onchato add <link>')); return }
    print(w.active, sys('kontakty (/query <nr> albo <nazwa>, Tab dopełnia):'))
    contactList.forEach((c, i) => {
      const r = rooms.get(c.pub)
      print(w.active, `  ${String(i + 1).padStart(2)}) ${online.has(c.pub) ? SGR.green + '●' : SGR.grey + '○'}${SGR.reset} ${c.name.padEnd(16)} ${SGR.grey}${r?.win ? 'okno ' + r.win.n : ''}${SGR.reset}`)
    })
  }
  /** Tab after /query: complete a contact's name; several matches are listed. */
  const complete = () => {
    const m = ed.text.match(/^(\/q(?:uery)? )(.*)$/); if (!m) return
    const hits = contactList.filter((c) => c.name.toLowerCase().startsWith(m[2].toLowerCase()))
    if (hits.length === 1) ed.set(m[1] + hits[0].name)
    else if (hits.length > 1) print(w.active, sys(hits.map((c) => c.name).join('  ')))
  }

  async function command(line: string) {
    const [cmd, ...args] = line.slice(1).split(' ')
    const arg = args.join(' ').trim()
    const room = roomOf(w.current())
    switch (cmd) {
      case 'win': case 'w': { const n = Number(arg); if (n) switchTo(n); break }
      case 'query': case 'q': {
        const gq = groups?.list().find((g) => g.name.toLowerCase() === arg.toLowerCase())
        if (gq) { switchTo(groupWin(gq).n); break }
        const c = findContact(arg); if (!c) { print(w.active, warn(`nie ma kontaktu ani grupy „${arg}” (/list, /groups)`)); break }
        const r = await openRoom(c)   // a window too, if it was only carrying group keys
        switchTo(r.win!.n); break
      }
      case 'close': {
        if (w.current().kind === 'group') { const n = w.active; w.close(n); switchTo(1); status(sys(`zamknięto okno ${n} - nadal jesteś w grupie (/groups)`)); break }
        if (!room) { print(w.active, warn('okna statusu nie zamkniesz')); break }
        rooms.delete(room.contact.pub)
        void room.conv?.leave()
        const n = room.win!.n; w.close(n); switchTo(1); status(sys(`zamknięto okno ${n} (${room.contact.name})`)); break
      }
      case 'list': showList(); break
      case 'who': {
        const gw = groupOf(w.current())
        if (gw && groups) {
          print(w.active, sys(`„${gw.name}” - ${gw.members.length} osób:`))
          for (const p of gw.members) {
            const tags = [p === gw.members[0] ? 'admin' : '', p !== o.id.pub && !isContact(p) ? `${SGR.yellow}spoza kontaktów${SGR.reset}${SGR.grey}` : '',
              groups.isAdmin(gw) && groups.owed.isOwed(gw.gid, p) ? 'zaproszenie czeka' : ''].filter(Boolean).join(' · ')
            print(w.active, `     ${p === o.id.pub || online.has(p) ? SGR.green + '●' : SGR.grey + '○'}${SGR.reset} ${memberName(p).padEnd(16)} ${SGR.grey}${tags}${SGR.reset}`)
          }
          break
        }
        if (!room?.conv) { print(w.active, sys('/who działa w oknie rozmowy albo grupy')); break }
        print(w.active, sys(room.conv.who().length ? `${room.contact.name} jest w pokoju` : `${room.contact.name} nie ma w pokoju`)); break
      }
      case 'me': {
        if (!room?.conv || !arg) break
        room.conv.sendText('ACTION ' + arg); print(w.active, `${t()} ${SGR.yellow}* ${o.id.handle} ${arg}${SGR.reset}`); break
      }
      case 'react': {
        if (!room?.conv || !arg) break
        if (!room.lastRecvId) { print(w.active, warn('nie ma jeszcze na co zareagować')); break }
        room.conv.sendReaction(room.lastRecvId, arg); print(w.active, `${t()} ${SGR.yellow}* ${o.id.handle} reaguje ${arg}${SGR.reset}`); break
      }
      case 'verify': {
        if (!room) { print(w.active, sys('/verify działa w oknie rozmowy')); break }
        const g = safetyGroups(await safetyNumber(unb64(o.id.pub), unb64(room.contact.pub)))
        print(w.active, sys('numer bezpieczeństwa (u obojga identyczny):'))
        for (let i = 0; i < 12; i += 4) print(w.active, `        ${SGR.cyan}${g.slice(i, i + 4).join(' ')}${SGR.reset}`)
        break
      }
      case 'groups': {
        const gl = groups?.list() ?? []
        if (!gl.length) { print(w.active, sys('nie należysz do żadnej grupy (/group new <nazwa> <kontakty…>)')); break }
        for (const g of gl) print(w.active, sys(`„${g.name}” · ${g.members.length} osób · okno ${groupWin(g).n}${groups!.isAdmin(g) ? ' · jesteś adminem' : ''}`))
        break
      }
      case 'group': {
        const [sub, gname, ...who] = args
        if (sub !== 'new' || !gname || !who.length || !groups) { print(w.active, warn('użycie: /group new <nazwa> <kontakt|nr> [<kontakt|nr>…]')); break }
        const picked = who.map((x) => findContact(x))
        const missing = who.filter((_, i) => !picked[i])
        if (missing.length) { print(w.active, warn(`nie ma kontaktów: ${missing.join(', ')} (/list)`)); break }
        print(w.active, sys('Każdy członek musi mieć pozostałych w kontaktach - inaczej nie będą widzieć swoich wiadomości.'))
        const g = await groups.create(gname, picked.map((c) => c!.pub))
        switchTo(groupWin(g).n)
        break
      }
      case 'knocks': {
        if (!knocks.length) { print(w.active, sys('nikt nie puka')); break }
        for (const k of knocks) print(w.active, sys(`${k.n}) ${k.name} · odcisk ${k.fp} · zaproszenie „${k.inv.label}”${k.note ? ' · „' + k.note + '”' : ''}`))
        break
      }
      case 'accept': case 'ignore': {
        const k = knocks.find((x) => x.n === Number(arg)); if (!k) { print(w.active, warn(`nie ma pukania nr ${arg} (/knocks)`)); break }
        knocks = knocks.filter((x) => x !== k)
        if (cmd === 'ignore') { await o.store?.ignore(k.fp); print(w.active, sys(`zignorowano ${k.name} (${k.fp}) - kolejne pukanie z tego klucza nie pojawi się`)); break }
        // Accepting IS adding the contact: they hold our key from the invite, now
        // we hold theirs, and both sides can compute the pair topic (§5.8).
        await o.contacts.add(k.name, k.ik, o.kind === 'HEM')
        await new Promise((r) => setTimeout(r, 150)) // the book's signature follows the write
        contactList.splice(0, contactList.length, ...(await o.contacts.list()))
        await session.watchContacts([{ pub: k.ik }], presence)
        print(w.active, sys(`${SGR.green}dodano ${k.name}${SGR.reset}${SGR.grey} - /query ${k.name}`))
        break
      }
      case 'send': {
        const gs = groupOf(w.current())
        if (!room?.conv && !gs?.room) { print(w.active, warn('/send działa w oknie rozmowy albo grupy')); break }
        const path = arg.replace(/^~(?=\/)/, process.env.HOME ?? '~')
        if (!path) { print(w.active, warn('użycie: /send <ścieżka do pliku>')); break }
        try {
          const meta = await prepareFile(path, (st) => print(w.active, sys(`${st}…`)))
          if (gs?.room) await gs.room.sendFile(meta); else room!.conv!.sendFile(meta)
          print(w.active, `${t()} ${SGR.yellow}${SGR.bold}<${o.id.handle}>${SGR.reset} 📎 ${meta.name} (${humanSize(meta.size)}) ${SGR.grey}- odbiorca ma ok. 5 min na pobranie${SGR.reset}`)
        } catch (e: any) { print(w.active, warn(`nie wysłano: ${e?.message ?? e}`)) }
        break
      }
      case 'get': {
        const fid = arg || room?.lastFile || ''
        const meta = files.get(fid)
        if (!meta) { print(w.active, warn(fid ? `nie ma pliku ${fid}` : 'nie ma pliku do pobrania (/get <id>)')); break }
        print(w.active, sys(`pobieram ${meta.name}…`))
        try { print(w.active, sys(`${SGR.green}zapisano${SGR.reset}${SGR.grey} ${await saveFile(meta, downloadDir())}`)) }
        catch (e: any) { print(w.active, warn(e?.message ?? String(e))) }
        break
      }
      case 'invite': print(w.active, sys(`Twój link: ${inviteLink(APP_ORIGIN, '/', { pub: o.id.pub, name: o.id.handle })}`)); break
      case 'clear': w.current().lines.length = 0; sc.drawWindow(w.current()); repaintStatus(); break
      case 'help':
        for (const h of ['/win N (Alt+N) · /query <nr|kontakt|grupa> · /close · /list · /who', '/groups · /group new <nazwa> <kontakt|nr>… - grupy; w oknie grupy piszesz do wszystkich, @Imię wzmiankuje', '/me <akcja> · /react <emoji> · /verify · /invite · /clear · /quit', '/send <plik> · /get [id] - pliki (odbiorca ma ok. 5 min na pobranie)', '/knocks · /accept N · /ignore N - pukanie do Twoich zaproszeń (onchato invites new)'])
          print(w.active, sys(h))
        break
      case 'quit': case 'exit': await quit(); break
      default: print(w.active, warn(`nieznane polecenie /${cmd} (/help)`))
    }
  }

  let quitting = false
  async function quit() {
    if (quitting) { o.io.exit(0); return }
    quitting = true
    status(sys('wylogowuję…'))
    const wd = setTimeout(() => { sc.stop(); o.io.exit(0) }, 2500)
    ;(wd as any).unref?.()
    for (const wt of inboxWatches.values()) { try { wt.stop() } catch {} }
    try { await Promise.all([...rooms.values()].map((r) => r.conv?.leave())) } catch {}
    try { await session.close() } catch {}
    clearTimeout(wd)
    sc.stop(); o.io.exit(0)
  }

  let lines: Promise<void> = Promise.resolve()
  async function submit(text: string) {
    if (text.startsWith('/')) { await command(text); return }
    const g = groupOf(w.current())
    if (g && groups) {
      await groups.send(g, text, memberName)
      print(w.active, `${t()} ${SGR.yellow}${SGR.bold}<${o.id.handle}>${SGR.reset} ${showMentions(text, g)}`)
      return
    }
    const room = roomOf(w.current())
    if (!room?.conv) { print(w.active, warn('to okno statusu - otwórz rozmowę: /query <kontakt>')); return }
    room.conv.sendText(text)
    print(w.active, `${t()} ${SGR.yellow}${SGR.bold}<${o.id.handle}>${SGR.reset} ${text}`)
  }

  o.io.onInput((chunk) => {
    for (const k of decodeKeys(chunk)) {
      if (k.t === 'alt-digit') { switchTo(k.n === 0 ? 10 : k.n); continue }
      if (k.t === 'ctrl' && (k.c === 'c' || k.c === 'd')) { void quit(); return }
      if (k.t === 'ctrl' && k.c === 'l') { sc.drawWindow(w.current()); repaintStatus(); continue }
      if (k.t === 'tab') { complete(); repaintStatus(); continue }
      const line = ed.apply(k)
      if (k.t === 'text') roomOf(w.current())?.conv?.noteActivity()
      if (line === null) { repaintStatus(); continue }
      const text = line.trim()
      if (!text) { repaintStatus(); continue }
      // Lines run IN ORDER: a message typed (or pasted) right after /query waits
      // for that window to open instead of landing on status and going nowhere.
      lines = lines.then(() => submit(text)).catch((e) => print(w.active, warn(String(e?.message ?? e))))
    }
  })
  o.io.onResize?.(() => { sc.start(); sc.drawWindow(w.current()); repaintStatus() })
  const clock = setInterval(repaintStatus, 30_000); (clock as any).unref?.()

  if (o.openFirst) await command('/query ' + o.openFirst)
  else {
    // The contact list comes up by itself, once presence has had a few seconds
    // to light the dots - nobody should have to know a name to start.
    const t0 = setTimeout(() => { if (!quitting && w.active === 1) showList() }, 3000); (t0 as any).unref?.()
  }
  repaintStatus()
  return { session, quit, windows: w }
}
