/**
 * app.ts — Encedo Chat web GUI (mockup skin). Login (HEM) → dashboard.
 *
 * Identity in the HEM (hem-sdk-js). Rendezvous/messages via the SAME engine as
 * the CLI (../../lib, WebCrypto). Browser libp2p peer dials the onchato relay.
 * Message crypto is INTERIM (lib/session.ts) — EH-2 replaces it. Content rides
 * GossipSub (interim); the §13 relay-blind data plane is pending the libp2p v3
 * ecosystem (gossipsub not yet migrated). Timestamps shown in UTC.
 *
 * Unbacked mockup elements (Groups/Network tabs, P1–P3 profiles, direct/relay
 * modes) are kept as visual placeholders until the engine backs them.
 */

import { HEM } from '../../../hem-sdk-js/hem-sdk.js'
import { hemIdentityFrom, browserSoftwareIdentity, startSession, hemContactBook, localContactBook, mergedContactBook, localOnlyManager, hemGkBackend, type Conversation, type ClientSession, type Identity, type ContactManager, type Contact } from '../../lib/core.ts'
import type { GkBackend } from '../../lib/group.ts'
// `t` is taken: this file uses it for text, topics, timers and DOM nodes, and a
// local shadowing the translator fails at runtime with "t is not a function" —
// which is exactly how it failed once. `tr` cannot collide.
import { t as tr, setLocale, getLocale, applyDom } from './i18n.ts'
import { probeCapabilities, formatReport } from '../../lib/capabilities.ts'
import { splitByLinks } from '../../lib/linkify.ts'
import { newFileKey, encryptBytes, decryptBytes, MAX_FILE } from '../../lib/filecrypto.ts'
import { putBlob, getBlob } from '../../net/ipfs.ts'
import type { FileEnv } from '../../lib/envelope.ts'
import { nowMs, utcHHMM } from '../../lib/time.ts'
import { nextRotationAfter } from '../../lib/presence.ts'
import { generateX25519, x25519FromPriv } from '../../lib/x25519.ts'
import { unb64, b64, randomBytes } from '../../lib/wc.ts'
import { sealCache, openCache } from '../../lib/gcache.ts'
import type { GroupRoom } from '../../lib/grouproom.ts'
import type { GroupSkdEnv } from '../../lib/envelope.ts'

const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'

// ---- network nodes (relays): an editable list, chosen at login -------------
// The user keeps a list of relay multiaddrs and ticks which to use this session;
// the first enabled one is the relay we dial (bs1 by default). Full multiaddrs so
// a node with its own PeerId (not derived from a pass) can be pasted in.
interface NodeEntry { name: string; addr: string; enabled: boolean }
const DEFAULT_NODES: NodeEntry[] = [{ name: 'bs1.onchato.com', addr: RELAY, enabled: true }]
function loadNodes(): NodeEntry[] {
  try { const v = JSON.parse(localStorage.getItem('ec-nodes') || 'null'); if (Array.isArray(v) && v.length) return v } catch {}
  return DEFAULT_NODES.map((n) => ({ ...n }))
}
function saveNodes(list: NodeEntry[]) { try { localStorage.setItem('ec-nodes', JSON.stringify(list)) } catch {} }
/** The relay to dial this session — the first enabled node, or bs1 as a floor. */
function chosenRelay(): string { return loadNodes().find((n) => n.enabled)?.addr || RELAY }
/**
 * All enabled nodes in list order — the failover candidates (3b). The first is
 * the preferred relay; if it is down the session falls through to the next.
 * Because the relays are meshed this does not split users. Never empty: bs1 is
 * the floor so a login with every node unchecked still has something to dial.
 */
function chosenRelays(): string[] {
  const on = loadNodes().filter((n) => n.enabled).map((n) => n.addr)
  return on.length ? on : [RELAY]
}
/**
 * Transport. libp2p is the default; `?mqtt=1` switches to the broker (fall-back
 * transport — README has the trade-offs), `?mqtt=wss://host/mqtt` points it
 * somewhere else. Everything above the transport is identical either way.
 */
const MQTT_PARAM = new URLSearchParams(location.search).get('mqtt')
const USE_MQTT = MQTT_PARAM !== null && MQTT_PARAM !== '0'
// The broker lives on the SAME host as the relay (bs1.onchato.com), not on the
// site the app is served from — deriving it from `location.hostname` pointed it
// at onchato.com, where there is no broker. Take the host straight from RELAY so
// the two can never drift.
const RELAY_HOST = RELAY.match(/\/dns4\/([^/]+)/)?.[1] ?? location.hostname
const BROKER = MQTT_PARAM && MQTT_PARAM.startsWith('ws') ? MQTT_PARAM : `wss://${RELAY_HOST}/mqtt`
// `?rot=<hour>` forces every pair's topic rotation to that UTC time-of-day, so
// two test tabs can share a known rollover instant instead of waiting for each
// pair's real offset (§5.4). Absent or `0` = the real per-pair offset algorithm
// (the default). Accepts an hour (`14`), a decimal hour (`14.5`), or `HH:MM`.
function parseRotSec(v: string | null): number | undefined {
  if (v == null || v === '' || v === '0') return undefined
  const hm = v.match(/^(\d{1,2}):(\d{2})$/)
  const sec = hm ? +hm[1] * 3600 + +hm[2] * 60 : Math.round(parseFloat(v) * 3600)
  return Number.isFinite(sec) && sec >= 0 && sec < 86400 ? sec : undefined
}
const FORCED_ROTATION_SEC = parseRotSec(new URLSearchParams(location.search).get('rot'))
// `?webrtc=0` keeps content on GossipSub — the direct DataChannel is never
// negotiated. Not a preference: a live Direct link carries the conversation
// whatever the relay is doing, so it MASKS every relay-path test. Validating 3b
// failover meant blocking `createOffer` from the browser console, which does not
// survive a reload; the same applies to diagnosing a user ("turn Direct off and
// see if it still works"). Absent or any other value = the default, Direct on.
const WEBRTC_OFF = new URLSearchParams(location.search).get('webrtc') === '0'
const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'
let session: { id: Identity; handle: string; pub: string; kid?: string; book: ContactManager } | null = null
/**
 * ONE transport for the whole app, opened at login: every room runs on it.
 * Building a node per conversation was invisible while only one chat was ever
 * open, and would have meant a WebSocket per contact the moment several are.
 */
let client: ClientSession | null = null
/** Resolves once the transport is up; rooms wait on it instead of on a null. */
let clientReady: Promise<ClientSession> | null = null

let linkState: 'online' | 'reconnecting' | 'offline' = 'online'

// ---- rooms: many open conversations, one shown at a time -------------------
// A message must not yank the view. An incoming conversation opens in the
// BACKGROUND — the handshake completes and the message is received — and only
// lights an unread dot on the contact list (Slack/Signal-style); the user
// switches when they want. Each room keeps a replayable LOG of its events, so
// switching to it just clears the transcript and replays that log through the
// same render functions: nothing is lost and no room is ever torn down to show
// another. The module-level render state (msgEls/stateEls/security DOM, the
// scroll counter) always describes whichever room is on screen.
type Ev =
  | { t: 'msg'; kind: 'me' | 'peer'; text: string; ts: number; id?: string; ooo?: boolean; who?: string; sent?: boolean }
  | { t: 'react'; id: string; emoji: string }
  | { t: 'delivery'; id: string; state: 'ok' | 'lost' | 'late'; ms?: number }
  | { t: 'sys'; text: string }
  // A file is its own event, not a message with a marker: it carries what is
  // needed to fetch and decrypt, and its bubble has an action rather than text.
  | { t: 'file'; kind: 'me' | 'peer'; who?: string; ts: number; file: FileEnv }
interface Room {
  contact: Contact
  conv: Conversation | null
  log: Ev[]
  unseen: number
  inRoom: boolean
  /** Header snapshots so a background room repaints correctly when shown. Two
   *  independent facts share the header — what the peer is doing, and whether WE
   *  have a transport at all (`linkState`, shared); a frozen laptop once looked
   *  exactly like a peer who left, so our own link wins when it is down. */
  security: Map<string, 'handshaking' | 'established' | 'failed'>
  transport: string
  peerLabel: string
  lastPresence: string | null
}
const rooms = new Map<string, Room>() // key = contact.pub
let activePub: string | null = null
let activeGid: string | null = null // a group is on screen instead of a 1:1 (see the groups module)
let wiping = false // wipeout in progress — block the unload flush from re-persisting groups
const activeRoom = (): Room | null => (activePub ? rooms.get(activePub) ?? null : null)
/** Am I actually LOOKING at this room? Being `activePub` is not enough — the
 *  mobile back-arrow leaves the room active but hides its pane (removes
 *  `.chat-open`). Without this the unread counter fired once, then messages for
 *  the still-active room rendered into the hidden pane instead of lighting the dot. */
const isViewing = (room: Room): boolean => room === activeRoom() && $('app').classList.contains('chat-open')
const LOG_CAP = 1000

function paintStatus() {
  const dot = $('peer-dot'), txt = $('peer-status')
  if (linkState !== 'online') {
    dot.className = 'dot bad'
    txt.textContent = linkState === 'reconnecting' ? tr('wznawiam połączenie…') : tr('brak połączenia z przekaźnikiem')
    return
  }
  if (activeGid) {
    // A group is on screen: its header is "N członków", not a 1:1 peer label. Without
    // this, every onLink/refresh repainted it as `activeRoom()?.peerLabel ?? 'łączę…'`
    // — activeRoom() is null for a group — so the group header flickered "łączę…".
    const gu = groupsUI.get(activeGid)
    dot.className = 'dot ok'
    txt.textContent = gu ? tr('{n} członków', { n: gu.members.length }) : ''
    return
  }
  const lp = activeRoom()?.lastPresence
  dot.className = 'dot ' + (lp === 'join' || lp === 'active' ? 'ok' : lp === 'away' || lp === 'quiet' ? 'away' : '')
  txt.textContent = activeRoom()?.peerLabel ?? tr('łączę…')
}
let rotTimer: any = null

const setMsg = (id: string, text: string, kind: 'err' | 'ok') => { const m = $(id); m.textContent = text; m.className = 'msg ' + kind }
const clr = (id: string) => { const m = $(id); m.textContent = ''; m.className = 'msg' }
const initials = (s: string) => (s || '?').slice(0, 2).toUpperCase()
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

async function fingerprint(pubB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0))
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}
function parseHandle(descr: Uint8Array | null): string {
  if (!descr) return '(?)'
  return dec.decode(descr).split('\0')[0].split(',')[1] ?? '(?)'
}

// ---- HEM reachability ----
async function refreshStatus() {
  const url = val('hsm'), dot = $('status-dot'), hint = $('status-hint')
  dot.className = 'dot'; hint.textContent = ''
  if (!url) return
  try { const v: any = await new HEM(url).getVersion(); dot.className = 'dot ok'; hint.textContent = `HEM ok — fw ${v?.fwv ?? '?'}` }
  catch { dot.className = 'dot bad'; hint.textContent = tr('HEM nieosiągalny (adres / CORS)') }
}
$('hsm').addEventListener('blur', refreshStatus)

// ---- login / register ----
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'
  const reg = mode === 'register'
  $('reg-handle-wrap').hidden = !reg
  $('go').textContent = reg ? 'Zarejestruj' : 'Zaloguj'
  $('toggle-pre').textContent = reg ? tr('Masz już konto?') : 'Nie masz konta?'
  $('toggle').textContent = reg ? 'Zaloguj' : tr('Zarejestruj tożsamość')
  clr('msg')
})
$('go').addEventListener('click', async () => {
  const url = val('hsm'), pass = val('pass')
  if (!url || !pass) { setMsg('msg', tr('Podaj adres HEM i hasło.'), 'err'); return }
  const btn = $('go') as HTMLButtonElement
  btn.disabled = true; btn.textContent = tr('…'); clr('msg')
  try {
    const hem = new HEM(url); await hem.hemCheckin()
    if (mode === 'register') {
      const handle = val('handle'); if (!handle) { setMsg('msg', tr('Podaj handle.'), 'err'); return }
      const gen = await hem.authorizePassword(pass, 'keymgmt:gen')
      const iat = Math.floor(Date.now() / 1000)
      const { kid } = await hem.createKeyPair(gen, `chat-ik-${handle}`, 'CURVE25519', btoa(`ETSEIC:self,${handle},ik,${iat}`))
      const use = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
      const { pubkey } = await hem.getPubKey(use, kid)
      await enterApp(hemIdentityFrom(hem, kid, handle, pubkey), mergedContactBook(hemContactBook(hem), makeLocalBook(handle, localStorage)), 'HEM', kid, hemGkBackend(hem, kid))
    } else {
      const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:self,')
      if (!keys.length) { setMsg('msg', tr('Brak tożsamości czatu na tym HEM — zarejestruj.'), 'err'); return }
      const key = keys[0]; const handle = parseHandle(key.description)
      const use = await hem.authorizePassword(null, `keymgmt:use:${key.kid}`)
      const { pubkey } = await hem.getPubKey(use, key.kid)
      await enterApp(hemIdentityFrom(hem, key.kid, handle, pubkey), mergedContactBook(hemContactBook(hem), makeLocalBook(handle, localStorage)), 'HEM', key.kid, hemGkBackend(hem, key.kid))
    }
  } catch (e: any) { setMsg('msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
  finally { const b = $('go') as HTMLButtonElement; b.disabled = false; b.textContent = mode === 'register' ? 'Zarejestruj' : 'Zaloguj' }
})
$('pass').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') ($('go') as HTMLButtonElement).click() })

// dev / no-HEM: a persistent software X25519 identity (localStorage — one per
// browser). For two peers, open two DIFFERENT browsers (or profiles).
$('go-soft').addEventListener('click', async () => {
  const handle = (val('handle') || prompt('Handle (software / dev):', 'dev1') || '').trim()
  if (!handle) return
  clr('msg')
  try {
    // One persistent software profile PER handle: typing "Lab1" loads (or first
    // creates) the Lab1 keypair; "Kab88" is its own identity, not whatever was
    // created first. Lets several software identities coexist (e.g. group testing
    // across tabs). The keystore lives in localStorage under ec-soft-id-<handle>.
    const key = 'ec-soft-id-' + handle
    const id = await browserSoftwareIdentity(handle, () => localStorage.getItem(key), (v) => localStorage.setItem(key, v))
    await enterApp(id, localOnlyManager(makeLocalBook(id.handle, localStorage)), 'Software · dev')
  } catch (e: any) { setMsg('msg', tr('Błąd tożsamości software: ') + (e?.message ?? e), 'err') }
})

// ---- the node editor: ONE implementation, used at login and after it -------
// It exists in two places (the login card and the Network tab) because both
// questions are real: which nodes to dial before a session, and which to dial
// while one is running. Two copies of this would drift, so the markup and the
// handlers are shared and only the message sink and the "what now" differ.
//
// Order is not cosmetic: `failoverDial` sweeps the list from the top, so row 1
// IS the primary and the rest are its fallbacks. Until the arrows existed the
// order was insertion order, i.e. nobody could choose their primary at all.
function nodeRowsHTML(list: NodeEntry[]): string {
  return list.map((n, i) =>
    `<label class="node-row"><input type="checkbox" data-i="${i}" ${n.enabled ? 'checked' : ''}>`
    + `<span class="n-name" title="${escapeHtml(n.addr)}">${escapeHtml(n.name)}${i === 0 ? ' <span class="n-first">' + tr('1. wybór') + '</span>' : ''}</span>`
    + `<span class="n-up${i === 0 ? ' off' : ''}" data-up="${i}" title="${tr('Wyżej (wyżej = wcześniej wybierany)')}">↑</span>`
    + `<span class="n-dn${i === list.length - 1 ? ' off' : ''}" data-dn="${i}" title="${tr('Niżej')}">↓</span>`
    + `<span class="n-x" data-rm="${i}" title="${tr('Usuń')}">×</span></label>`).join('')
}
/**
 * Bind one editor. `warn` reports refusals, `onChange` is what the caller does
 * with a changed list (nothing at login — the list is read when the session
 * starts; a live `setRelays` in the Network tab). Returns its redraw.
 */
function bindNodeEditor(listId: string, addId: string, warn: (t: string) => void, onChange: () => void) {
  const redraw = () => { $(listId).innerHTML = nodeRowsHTML(loadNodes()) }
  $(listId).addEventListener('change', (e: any) => {
    const i = e.target?.dataset?.i; if (i == null) return
    const list = loadNodes(); list[+i].enabled = e.target.checked
    if (!list.some((n) => n.enabled)) { list[+i].enabled = true; e.target.checked = true; warn(tr('Przynajmniej jeden węzeł musi być aktywny.')); return }
    saveNodes(list); onChange()
  })
  $(listId).addEventListener('click', (e: any) => {
    const d = e.target?.dataset ?? {}
    const { rm, up, dn } = d
    if (rm == null && up == null && dn == null) return
    e.preventDefault() // the row is a <label>: ANY click inside it toggles the checkbox
    const list = loadNodes()
    if (rm != null) {
      if (list.length <= 1) { warn(tr('Musi zostać co najmniej jeden węzeł.')); return }
      list.splice(+rm, 1); if (!list.some((n) => n.enabled)) list[0].enabled = true
    } else {
      const i = +(up ?? dn), j = up != null ? i - 1 : i + 1
      if (j < 0 || j >= list.length) return // the end arrows are inert, not missing
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    saveNodes(list); redraw(); onChange()
  })
  $(addId).addEventListener('click', () => {
    const addr = (prompt('Multiaddr węzła (np. /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo…):') || '').trim()
    if (!addr) return
    if (!addr.startsWith('/') || !addr.includes('/p2p/')) { warn(tr('To nie wygląda na multiaddr (…/p2p/<PeerId>).')); return }
    const host = addr.match(/\/dns[46]\/([^/]+)/)?.[1] ?? addr.match(/\/ip[46]\/([^/]+)/)?.[1] ?? tr('węzeł')
    const name = (prompt('Nazwa węzła:', host) || host).trim()
    const list = loadNodes(); list.push({ name, addr, enabled: true }); saveNodes(list); redraw(); onChange()
  })
  return redraw
}

// ---- login: editable network-node list (collapsed; the "+" reveals it) ----
const renderNodes = bindNodeEditor('nodes-list', 'node-add', (t) => setMsg('msg', t, 'err'), () => {})
$('nodes-toggle').addEventListener('click', () => {
  const panel = $('nodes-panel'), open = panel.hidden
  panel.hidden = !open; $('nodes-toggle').classList.toggle('open', open)
  if (open) renderNodes()
})

function makeLocalBook(handle: string, storage: Storage) {
  const lsKey = 'ec-local-contacts-' + handle
  return localContactBook(
    () => { try { return JSON.parse(storage.getItem(lsKey) || '[]') } catch { return [] } },
    (l) => storage.setItem(lsKey, JSON.stringify(l)),
  )
}

/** Short form of an HSM key id — the full one is long and adds no meaning here. */
const shortKid = (kid?: string) => (kid ? kid.slice(0, 8) + '…' : '')

async function enterApp(id: Identity, book: ContactManager, sourceLabel: string, kid?: string, gkBackend?: GkBackend) {
  session = { id, handle: id.handle, pub: id.pub, kid, book }
  // Start the transport, but do NOT make the app shell wait for it: dialing a
  // relay is network work, and a login screen that hangs on it looks broken
  // (it also blocked the first automated run of this app outright).
  clientReady = startSession(id, {
    relay: chosenRelay(),
    relays: chosenRelays(),   // 3b: fall through the enabled node list if one is down
    gkBackend,                // §8 bucket A: a HEM identity mints GK in the HSM
    transport: USE_MQTT ? 'mqtt' : 'libp2p',
    broker: BROKER,
    forcedRotationSec: FORCED_ROTATION_SEC,
    onGroupSkd: (from, skd) => { void onGroupInvite(from, skd) }, // a group invite arrived over a 1:1

    onLog: ecLog,
    onLink: (state) => {
      linkState = state; paintStatus()
      // The relay came back: 1:1 rooms are refreshed by core, but groups are passive
      // and not registered there — re-warm their meshes so they don't stay silently dead.
      if (state === 'online') for (const gu of groupsUI.values()) gu.room?.refresh()
    },
    onRelay: (addr) => {
      // Failed over to another node (or returned to the primary). Tell the user
      // which node is carrying them now, and refresh the Network tab if it is open.
      const name = loadNodes().find((n) => n.addr === addr)?.name
        ?? (addr.match(/dns4\/([^/]+)/) ?? addr.match(/ip6\/([^/]+)/) ?? [, addr.slice(0, 24)])[1]
      const primary = chosenRelays()[0]
      toast(addr === primary ? tr('Wróciłem na węzeł {name}', { name }) : tr('Przełączono na węzeł {name} (poprzedni niedostępny)', { name }))
      renderNetwork()
    },
    onSessionTakenOver: () => {
      // §9.1/§9.2: a second window of this identity showed up, so BOTH stand
      // down — the other one is doing exactly this too. The transport is gone
      // by now; clear the transcript, because this window cannot decrypt
      // anything any more, and say plainly what to do about it.
      for (const r of rooms.values()) { r.conv = null; r.inRoom = false }
      $('messages').innerHTML = ''
      msgEls.clear(); stateEls.clear(); setTyping(false)
      appendMsg('sys', tr('Wykryto drugie okno zalogowane na tę samą tożsamość.')
        + tr(' Obie sesje zostały zamknięte — jedna tożsamość, jedna aktywna sesja.')
        + tr(' Zamknij nadmiarową kartę i odśwież tę, w której chcesz rozmawiać.'))
      linkState = 'offline'
      paintStatus()
      $('peer-status').textContent = tr('sesja zamknięta (duplikat)')
    },
  })
  clientReady.then((c) => { client = c; void restoreGroups() }, (e: any) => {
    ecLog(`session failed to start: ${e?.message ?? e}`)
    toast(tr('Brak połączenia z przekaźnikiem — odśwież stronę'))
  })
  $('login').hidden = true; $('app').hidden = false
  $('me-avatar').textContent = initials(id.handle)
  $('me-handle').textContent = id.handle
  const fp = await fingerprint(id.pub)
  $('me-fp').textContent = tr('🔑 ') + fp
  $('me-fp').title = kid ? `KID ${kid} · dwuklik = kopiuj klucz publiczny` : 'Dwuklik = kopiuj klucz publiczny'
  $('sess-id').textContent = sourceLabel + ' · ' + fp
  $('sess-kid').textContent = kid ?? tr('— (klucz w przeglądarce)')
  $('sess-kid').title = kid ?? tr('Tożsamość programowa — brak klucza w HSM')
  refreshContacts()
}

// ---- contacts (HEM-backed book; in-memory cache keeps re-renders cheap) ----
let contactsCache: Contact[] = []
/** pub → fingerprint. Peers are shown exactly like our own identity: the
 *  8-byte SHA-256 of the key, not the raw base64 nobody can compare by eye. */
const fpCache = new Map<string, string>()
async function refreshContacts() {
  if (!session) return
  try { contactsCache = await session.book.list() }
  catch (e: any) { toast(tr('Błąd listy kontaktów: ') + (e?.message ?? e)) }
  for (const c of contactsCache) if (!fpCache.has(c.pub)) fpCache.set(c.pub, await fingerprint(c.pub))
  renderContacts()
  void syncPresence()
}

/** Contacts we currently show a green dot for, and the ones we hold a light
 *  presence watch on. The heavy conversation is a separate thing — being here
 *  means "announcing on our pair topic", no handshake, no room. */
const onlinePubs = new Set<string>()
const watchedPubs = new Set<string>()

/**
 * Bring the presence watches in line with the contact list: watch anyone new,
 * drop anyone removed. `watchContacts` starts a light watcher per contact (see
 * core `watchContacts` / `lib/presence.ts`) and calls back on the transitions —
 * a dot, and, when the contact actually sends, `onWantsConversation`, which is
 * the whole upgrade path: their EH-2 frame reached our watcher, so we open the
 * full room and it takes over the warm topic. Idempotent — safe to call on
 * every contact change; `startWatch` skips anyone already watched.
 */
async function syncPresence() {
  if (!clientReady) return
  let c: ClientSession
  try { c = await clientReady } catch { return }
  const current = new Set(contactsCache.map((x) => x.pub))
  for (const pub of [...watchedPubs]) if (!current.has(pub)) { c.unwatch(pub); watchedPubs.delete(pub); onlinePubs.delete(pub) }
  // Exclude only the ON-SCREEN room: it handed its topic to the room, which drives
  // that contact's dot via `inRoom`. Every OTHER contact — including ones with a
  // BACKGROUND room open — is light-watched, so its green "online" dot works again
  // (the earlier "exclude every open room" left opened contacts permanently
  // unwatched, since background rooms never close). The extra light watch over a
  // background room's topic is benign: idempotent subscribe, a harmless second
  // announce, and `onWantsConversation` is guarded by `rooms.has`.
  const toWatch = contactsCache.filter((x) => x.pub !== activePub)
  await c.watchContacts(toWatch.map((x) => ({ pub: x.pub, kid: x.kid })), {
    onOnline: (p) => { if (!onlinePubs.has(p.pub)) { onlinePubs.add(p.pub); renderContacts() } },
    onOffline: (p) => { if (onlinePubs.delete(p.pub)) renderContacts() },
    onWantsConversation: (p) => {
      // The contact is opening EH-2. Open the room IN THE BACKGROUND so their
      // frame is replayed and the handshake completes and the message arrives —
      // but do NOT steal the view (5 people writing must not thrash the UI).
      // A dot lights on the contact; the user switches when they want.
      const contact = contactsCache.find((x) => x.pub === p.pub)
      if (!contact || rooms.has(p.pub)) return
      toast(tr('{name} chce rozmawiać…', { name: contact.name }))
      void openRoomFor(contact, false)
    },
  })
  // Record every contact (incl. the active one, whose watch core owns and
  // restores on leave) so removal always tears its watch down.
  for (const x of contactsCache) watchedPubs.add(x.pub)
}
function renderContacts() {
  const pane = $('pane-contacts'); pane.innerHTML = ''
  // Add-peer lives INSIDE the contacts pane (like "+ Nowa grupa" in groups), so it
  // only shows on this tab — and above the empty-state, since that is when you need it.
  const add = document.createElement('div'); add.className = 'add-row'
  const addBtn = document.createElement('button'); addBtn.className = 'add-btn'; addBtn.textContent = tr('+ Dodaj peera')
  addBtn.addEventListener('click', () => openModal()); add.appendChild(addBtn); pane.appendChild(add)
  const filter = val('contact-search').toLowerCase()
  const list = contactsCache.filter((c) => !filter || c.name.toLowerCase().includes(filter))
  if (!list.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = filter ? tr('(brak dopasowań)') : tr('(brak kontaktów — dodaj peera)'); pane.appendChild(e); return }
  for (const c of list) {
    const room = rooms.get(c.pub)
    const inRoom = !!room?.inRoom
    const online = onlinePubs.has(c.pub)
    const unseen = room?.unseen ?? 0
    const dotTitle = inRoom ? 'W rozmowie' : online ? 'Online (widoczny na Waszym topicu)' : 'Offline'
    const src = c.source === 'hem' ? { i: '🔒', t: tr('W HEM (trwałe, przenośne)') } : { i: '💻', t: tr('Lokalnie (ta przeglądarka)') }
    const b = document.createElement('button'); b.className = 'contact' + (activePub === c.pub ? ' active' : '') + (unseen ? ' unread' : '')
    // The unread pill is the whole point of the background model: a message that
    // arrived while you were elsewhere lights here instead of yanking the view.
    const pill = unseen ? `<span class="c-unread" title="${unseen} nieprzeczytane">${unseen > 99 ? '99+' : unseen}</span>` : ''
    b.innerHTML = `<span class="dot ${inRoom || online ? 'ok' : ''}" title="${dotTitle}"></span><div class="avatar">${escapeHtml(initials(c.name))}</div>`
      + `<div class="c-info"><div class="c-name">${escapeHtml(c.name)} <span class="src" title="${src.t}">${src.i}</span></div>`
      + `<div class="c-sub" title="${escapeHtml(c.kid ? `KID ${c.kid}` : c.pub)}">🔑 ${escapeHtml(fpCache.get(c.pub) ?? '…')}${c.kid ? ' · KID ' + escapeHtml(shortKid(c.kid)) : ''}</div></div>`
      + pill + `<button class="c-edit" title="${tr('Zmień nazwę')}">✎</button><span class="c-x" title="${tr('Usuń')}">×</span>`
    b.addEventListener('click', async (e: any) => {
      if (e.target.classList.contains('c-edit')) {
        e.stopPropagation()
        const name = await promptName(tr('Zmień nazwę kontaktu'), `Widoczna tylko u Ciebie — ${c.name} nie zostanie o niej powiadomiony.`, c.name)
        if (name) await renameContact(c, name)
        return
      }
      if (e.target.classList.contains('c-x')) {
        e.stopPropagation()
        // Deleting a contact tears down the conversation and, on a HEM, removes
        // the imported key — not something to do on a mis-tap next to the name.
        if (!(await ask(tr('Usunąć kontakt?'), tr('„{name}” zniknie z listy, rozmowa zostanie zamknięta', { name: c.name })
          + `${c.source === 'hem' ? tr(', a klucz kontaktu zostanie usunięty z HEM') : ''}. Historia rozmowy i tak nie jest przechowywana.`, tr('Usuń'))).ok) return
        await closeRoom(c.pub)
        if (session) { try { await session.book.remove(c) } catch (err: any) { toast(tr('Błąd usuwania: ') + (err?.message ?? err)) } }
        await refreshContacts(); return
      }
      void openRoomFor(c, true)
    })
    pane.appendChild(b)
  }
}
$('contact-search').addEventListener('input', renderContacts)

// ---- ask / rename: two promise-shaped modals reused by every destructive or
// editing action. Deliberately NOT window.confirm/prompt: a mobile webview
// draws those as browser chrome outside the app's skin, and they block the
// event loop — which here means the transport stops pumping while a dialog is
// open. -------------------------------------------------------------------
function ask(title: string, body: string, yes = 'Tak', rememberLabel?: string, href?: string): Promise<{ ok: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    $('ask-title').textContent = title
    $('ask-body').textContent = body
    $('ask-yes').textContent = yes
    // The checkbox is opt-in per call: a destructive confirm must never offer to
    // stop asking, only an advisory one may.
    // Both of these are OPTIONAL parts of the dialog, so they are read
    // defensively: a confirm that cannot be dismissed is worse than one without
    // a checkbox, and this exact shape failed once — the markup had not landed,
    // `$()` returned null, the assignment threw, and the click died after
    // preventDefault with no dialog and no navigation.
    const cb = document.getElementById('ask-remember') as HTMLInputElement | null
    const wrap = document.getElementById('ask-remember-wrap')
    if (cb) cb.checked = false
    if (wrap) {
      wrap.hidden = !rememberLabel
      const label = wrap.querySelector('span')
      if (rememberLabel && label) label.textContent = rememberLabel
    }
    // A link confirm affirms with an anchor, so the navigation is the user's own
    // click. `window.open` after an awaited dialog is outside the gesture and
    // browsers block it.
    const open = document.getElementById('ask-open') as HTMLAnchorElement | null
    if (open) {
      open.hidden = !href
      if (href) { open.href = href; open.textContent = yes }
    }
    $('ask-yes').hidden = !!(href && open)
    $('members-pop').hidden = true // nothing may stay clickable behind a modal
    $('scrim').classList.add('open'); $('ask-modal').classList.add('open')
    const done = (v: boolean) => {
      const remember = !!(rememberLabel && cb?.checked)
      $('scrim').classList.remove('open'); $('ask-modal').classList.remove('open')
      $('ask-yes').removeEventListener('click', onYes)
      document.getElementById('ask-open')?.removeEventListener('click', onYes)
      $('ask-no').removeEventListener('click', onNo)
      $('scrim').removeEventListener('click', onScrim)
      document.removeEventListener('keydown', onKey)
      resolve({ ok: v, remember })
    }
    const onYes = () => done(true), onNo = () => done(false)
    // Clicking the backdrop is the third way out, alongside Escape and "Nie".
    // A destructive dialog should be easy to leave and deliberate to confirm.
    const onScrim = () => done(false)
    // Escape cancels. A destructive dialog must have a way out that is not a click.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true) }
    $('ask-yes').addEventListener('click', onYes)
    document.getElementById('ask-open')?.addEventListener('click', onYes) // navigates natively; this only closes
    $('ask-no').addEventListener('click', onNo)
    $('scrim').addEventListener('click', onScrim)
    document.addEventListener('keydown', onKey)
    $('ask-no').focus() // the safe option is the one under the finger
  })
}

function promptName(title: string, sub: string, current: string, label = 'Nazwa'): Promise<string | null> {
  return new Promise((resolve) => {
    $('rename-title').textContent = title
    $('rename-sub').textContent = sub
    $('rename-label').textContent = label
    clr('rename-msg')
    const input = $('rename-input') as HTMLInputElement
    input.value = current
    $('members-pop').hidden = true
    $('scrim').classList.add('open'); $('rename-modal').classList.add('open')
    const done = (v: string | null) => {
      $('scrim').classList.remove('open'); $('rename-modal').classList.remove('open')
      $('rename-save').removeEventListener('click', onSave)
      $('rename-cancel').removeEventListener('click', onCancel)
      $('scrim').removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKey)
      resolve(v)
    }
    const onSave = () => {
      const v = input.value.trim()
      if (!v) { setMsg('rename-msg', tr('Nazwa nie może być pusta.'), 'err'); return }
      done(v === current ? null : v) // unchanged is the same as cancelled
    }
    const onCancel = () => done(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }
    $('rename-save').addEventListener('click', onSave)
    $('rename-cancel').addEventListener('click', onCancel)
    $('scrim').addEventListener('click', onCancel)
    input.addEventListener('keydown', onKey)
    input.focus(); input.select()
  })
}

/**
 * Rename a contact. Local to this device by design: the name is how YOU refer
 * to a key, it is not part of anyone's identity, and telling the peer would
 * leak a label they never chose. The key, its KID and every open room survive —
 * on a HEM this rewrites one DESCR rather than deleting and re-importing, so
 * the KID (a roster hint in group markers, §8) does not move.
 */
async function renameContact(c: Contact, name: string) {
  if (!session) return
  try {
    await session.book.rename(c, name)
    // Anything already showing the old name: the contact list, the open room's
    // header, and every group this contact is a member of.
    for (const gu of groupsUI.values()) {
      const m = gu.members.find((x) => x.pub === c.pub); if (m) m.name = name
    }
    await refreshContacts()
    if (activePub === c.pub) { $('peer-name').textContent = name; $('peer-name').title = name }
    if (activeGid) renderGroups()
    toast(`Kontakt to teraz „${name}"`)
  } catch (e: any) { toast(tr('Nie udało się zmienić nazwy: ') + (e?.message ?? e)) }
}

// ---- add-peer modal ----
const openModal = () => { $('scrim').classList.add('open'); $('add-modal').classList.add('open'); clr('add-msg'); ;($('add-name') as HTMLInputElement).value = ''; ($('add-pub') as HTMLInputElement).value = ''; ;(document.querySelector('input[name="store"][value="hem"]') as HTMLInputElement).checked = true; $('add-name').focus() }
const closeModal = () => { $('scrim').classList.remove('open'); $('add-modal').classList.remove('open') }
$('add-cancel').addEventListener('click', closeModal)
$('add-save').addEventListener('click', async () => {
  if (!session) return
  const name = val('add-name'), pub = val('add-pub')
  if (!name || !pub) { setMsg('add-msg', tr('Podaj nazwę i klucz.'), 'err'); return }
  try { if (Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)).length !== 32) { setMsg('add-msg', tr('Klucz nie wygląda na 32-bajtowy X25519 (base64).'), 'err'); return } }
  catch { setMsg('add-msg', tr('Klucz nie jest poprawnym base64.'), 'err'); return }
  const store = (document.querySelector('input[name="store"]:checked') as HTMLInputElement | null)?.value ?? 'hem'
  if (store === 'none') { closeModal(); void openRoomFor({ name, pub, source: 'local' }, true); return } // ephemeral — nothing saved (HEM nor localStorage)
  const persistent = store !== 'local'
  const btn = $('add-save') as HTMLButtonElement; btn.disabled = true; btn.textContent = tr('Zapisuję…')
  try {
    const dup = contactsCache.find((c) => c.name === name)
    if (dup) await session.book.remove(dup)   // upsert: replace an existing peer of the same name (any source)
    await session.book.add(name, pub, persistent)
    await refreshContacts()
    closeModal()
  } catch (e: any) { setMsg('add-msg', tr('Błąd zapisu: ') + (e?.message ?? e), 'err') }
  finally { btn.disabled = false; btn.textContent = tr('Zapisz') }
})

// ---- settings drawer ----
const openDrawer = () => { $('scrim').classList.add('open'); $('drawer').classList.add('open') }
const closeDrawer = () => { $('scrim').classList.remove('open'); $('drawer').classList.remove('open') }
$('btn-settings').addEventListener('click', openDrawer)
$('chip-profile').addEventListener('click', openDrawer)
$('btn-close-drawer').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', () => { closeModal(); closeDrawer() })
$('btn-logout').addEventListener('click', () => location.reload())

// ---- attach a file --------------------------------------------------------
/**
 * The clip PICKS; Send sends. Nothing is encrypted or uploaded at pick time, so
 * a file chosen by mistake costs one click to drop rather than an upload to sit
 * through — and the caption typed after choosing travels with it, which it
 * cannot do if the send has already left.
 */
let pendingAttach: File | null = null

/** The chip is the whole of the pending state's UI, so this is the only place
 *  the variable and the DOM can drift apart — set them together, always. */
function showAttach(f: File | null) {
  pendingAttach = f
  $('attach-chip').hidden = !f
  if (!f) return
  $('attach-name').textContent = f.name
  $('attach-name').title = f.name // the chip elides; the tooltip has the whole name
  $('attach-size').textContent = humanSize(f.size)
}

$('btn-attach').addEventListener('click', () => ($('file-input') as HTMLInputElement).click())
;($('file-input') as HTMLInputElement).addEventListener('change', (e: any) => {
  const f = e.target.files?.[0]
  e.target.value = '' // so picking the same file twice still fires
  if (!f) return
  // Refused at PICK time rather than at Send: the limit is a property of the
  // file alone, and finding out after writing a caption is a worse way to learn.
  if (f.size > MAX_FILE) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return }
  showAttach(f)
})
$('attach-drop').addEventListener('click', () => showAttach(null))

/**
 * Empty the composer when the screen changes rooms.
 *
 * Switching rooms is the one moment the RECIPIENT changes while the composer
 * looks untouched — so text meant for one peer, or a file picked for them, would
 * otherwise sit one Send away from the next. Both go.
 */
function clearComposer() {
  ;($('msg-input') as HTMLInputElement).value = ''
  showAttach(null)
}

// ---- language ------------------------------------------------------------
// The static markup carries its Polish as default content, so the app is
// readable before this runs and stays readable if it throws. `applyDom`
// translates it in place; switching repaints it without a reload, because the
// transport and every open ratchet would not survive one.
{
  const sel = $('lang-select') as HTMLSelectElement
  if (sel) {
    sel.value = getLocale()
    sel.addEventListener('change', () => { setLocale(sel.value); renderContacts(); renderGroups() })
  }
  document.documentElement.lang = getLocale()
  applyDom()
  // Paint the two header badges through the same helper the running app uses.
  // Their markup carries the icon/text split from the start (so the phone rule
  // has something to collapse before anything is painted), and this makes the
  // wording translated from the first frame rather than after the first room.
  setBadge($('transport-badge'), 'badge relay', tr('⚪ Relay'), tr('Treść przez relay (GossipSub)'))
  setBadge($('e2e-badge'), 'badge e2e', tr('🔒 E2E interim'), tr('Szyfrowane E2E — interim, EH-2 w drodze'))
}
$('btn-wipeout').addEventListener('click', async () => {
  if (!confirm('Wipeout: skasować lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki?\n\nTego nie da się cofnąć — Twój klucz publiczny się zmieni, więc Ty i rozmówcy musicie wymienić się nowymi kluczami. Klucze w HSM (login HEM) zostają nietknięte.')) return
  // §10 WIPE — reset like a new machine. Tear the live session down first (leave
  // rooms so peers see us go, drop the transport), then delete every ec-* key we
  // own, then reload to login. HEM-held keys live in the HSM and are untouched.
  ecLog('WIPEOUT — clearing all local state')
  wiping = true // stop persistGroups: the reload below fires unload handlers that would re-save
  clearTimeout(persistTimer)
  try { for (const r of rooms.values()) r.conv?.leave() } catch {}
  try { client?.close() } catch {}
  for (const k of Object.keys(localStorage)) { if (k.startsWith('ec-')) localStorage.removeItem(k) }
  location.reload()
})

// ---- resizable sidebar / chat splitter (desktop; hidden on phones) ----
{
  const SB_MIN = 260, SB_MAX = 560, SB_DEF = 330
  const setW = (w: number) => document.documentElement.style.setProperty('--sidebar-w', w + 'px')
  const saved = parseInt(localStorage.getItem('ec-sidebar-w') || '', 10)
  if (saved >= SB_MIN && saved <= SB_MAX) setW(saved)
  const splitter = $('splitter'); const sidebar = document.querySelector('.sidebar') as HTMLElement
  let dragging = false
  splitter.addEventListener('mousedown', (e: any) => { dragging = true; splitter.classList.add('drag'); e.preventDefault() })
  window.addEventListener('mousemove', (e: any) => {
    if (!dragging) return
    const w = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(e.clientX - sidebar.getBoundingClientRect().left)))
    setW(w)
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; splitter.classList.remove('drag')
    localStorage.setItem('ec-sidebar-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || SB_DEF))
  })
  splitter.addEventListener('dblclick', () => { setW(SB_DEF); localStorage.setItem('ec-sidebar-w', String(SB_DEF)) })
}
// Close the group members popover on any outside click.
document.addEventListener('click', (e: any) => {
  const pop = $('members-pop')
  // The popover has two openers now (the chat header cluster and a row in the
  // group list), so "outside" means outside the popover AND outside whichever
  // element opened it.
  if (pop.hidden) return
  if (pop.contains(e.target)) return
  if ($('members-cluster').contains(e.target)) return
  if (popAnchor?.contains(e.target)) return
  pop.hidden = true
})
// Admin actions inside the members popover (event-delegated — the pop is rebuilt
// on every open). stopPropagation so the outside-click close above does not fire.
$('members-pop').addEventListener('click', (e: any) => {
  const gid = popMembersGid ?? activeGid
  const gu = gid ? groupsUI.get(gid) : null
  if (!gu) return
  const rm = (e.target as HTMLElement).closest('[data-rm]') as HTMLElement | null
  if (rm) { e.stopPropagation(); const pub = rm.getAttribute('data-rm')!
    void changeMembers(gu.gid, gu.members.filter((m) => m.pub !== pub), tr('{name} usunięty z grupy', { name: memberName(pub) })); return }
  const tog = (e.target as HTMLElement).closest('[data-addmember]') as HTMLElement | null
  if (tog) { e.stopPropagation(); const list = $('members-pop').querySelector('.m-add-list') as HTMLElement | null; if (list) list.hidden = !list.hidden; return }
  const add = (e.target as HTMLElement).closest('[data-add-pub]') as HTMLElement | null
  if (add) { e.stopPropagation(); const pub = add.getAttribute('data-add-pub')!
    void changeMembers(gu.gid, [...gu.members, { pub, name: memberName(pub) }], `${memberName(pub)} dodany do grupy`); return }
})

// ---- copy my pubkey ----
let toastT: any
function toast(msg: string) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show')
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1500)
}
async function copyPub() {
  if (!session) return
  try {
    await navigator.clipboard.writeText(session.pub)
  } catch {
    const ta = document.createElement('textarea'); ta.value = session.pub; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove()
  }
  toast(tr('Skopiowano klucz publiczny ✓'))
}
$('me-fp').addEventListener('dblclick', copyPub)       // double-click fingerprint → copy pubkey
$('sess-id').addEventListener('dblclick', copyPub)     // double-click Tożsamość → copy pubkey

// ---- placeholder tabs ----
for (const [tab, pane] of [['tab-contacts', 'contacts'], ['tab-groups', 'groups'], ['tab-network', 'network']]) {
  $(tab).addEventListener('click', () => {
    for (const t of ['tab-contacts', 'tab-groups', 'tab-network']) $(t).classList.toggle('active', t === tab)
    for (const p of ['contacts', 'groups', 'network']) $('pane-' + p).hidden = (p !== pane)
    if (pane === 'groups') renderGroups()
    if (pane === 'network') startNetwork(); else stopNetwork()
  })
}

// ---- Network tab: a live view of the transport, plus the node editor -------
let netTimer: any = null
const NODES_NOTE = tr('Kolejność decyduje o wyborze: pierwszy aktywny węzeł jest podstawowy, kolejne to zapas. Zmiany działają natychmiast — bez wylogowania.')
/**
 * The pane is built ONCE and only its live half repainted. The editor below it
 * holds a checkbox, arrows and prompt-driven input, and `renderNetwork` runs
 * every 2.5 s — rebuilding the editor under the user's cursor would swallow
 * clicks and re-bind handlers on every tick.
 */
function ensureNetworkShell() {
  if ($('net-live')) return
  $('pane-network').innerHTML = `<div id="net-live"></div>
    <div class="nodes-panel net-nodes">
      <div class="nodes-head"><span>${tr('Węzły sieci')}</span> <button class="node-add" id="net-node-add" type="button">${tr('+ dodaj')}</button></div>
      <div id="net-nodes-list"></div>
      <div class="net-note" id="net-nodes-note">${NODES_NOTE}</div>
    </div>`
  const note = () => $('net-nodes-note')
  bindNodeEditor('net-nodes-list', 'net-node-add',
    (t) => { note().textContent = t; note().classList.add('err') },
    () => {
      note().textContent = NODES_NOTE; note().classList.remove('err')
      // Live: the running session dials the new list from now on. Dropping the
      // node we are ON re-dials at once; a reorder waits for the next sweep.
      client?.setRelays(chosenRelays())
      renderNetwork()
    })()
}
function renderNetwork() {
  const pane = $('pane-network'); if (!pane) return
  if (!client) { pane.innerHTML = `<div class="pane-label">${tr('Brak sesji — zaloguj się.')}</div>`; return }
  ensureNetworkShell()
  const s = client.netStatus()
  const relayHost = (s.relay.match(/dns4\/([^/]+)/) ?? s.relay.match(/\/\/([^/:]+)/) ?? [, s.relay.slice(0, 40)])[1]
  const relayPeer = (s.relay.match(/p2p\/([^/]+)/) ?? [, ''])[1]
  const groupTopics = new Set([...groupsUI.values()].map((g) => g.room?.topic).filter(Boolean))
  const gCount = s.topics.filter((t) => groupTopics.has(t)).length
  const online = s.link === 'online' && s.connected
  const linkTxt = online ? tr('połączony') : s.link === 'reconnecting' ? 'wznawiam…' : s.link === 'offline' ? 'offline' : tr('łączę…')
  const linkCls = online ? 'ok' : s.link === 'reconnecting' ? 'away' : 'bad'
  // Failover view (3b): the candidate node list, with the live one marked. A
  // failover is simply "the active relay is not the first choice".
  const nodeName = (a: string) => loadNodes().find((n) => n.addr === a)?.name
    ?? (a.match(/dns4\/([^/]+)/) ?? a.match(/ip6\/([^/]+)/) ?? [, a.slice(0, 28)])[1] as string
  const candidates = chosenRelays()
  const isFailover = candidates.length > 1 && s.relay !== candidates[0]
  const nodesRow = candidates.length > 1
    ? `<div class="net-row wrap"><span class="k">${tr('Lista węzłów')}</span><span class="v net-nodes chips">${candidates.map((a) => {
        const act = a === s.relay
        return `<span class="net-node${act ? ' act' : ''}" title="${escapeHtml(a)}">${act ? '●' : '○'} ${escapeHtml(nodeName(a))}</span>`
      }).join('')}</span></div>`
    : ''
  $('net-live').innerHTML = `<div class="net-card">
    <div class="net-row"><span class="k">${tr('Status')}</span><span class="v"><span class="dot ${linkCls}"></span> ${linkTxt}${s.peers ? ` · ${tr('{n} poł.', { n: s.peers })}` : ''}</span></div>
    <div class="net-row"><span class="k">${tr('Transport')}</span><span class="v">${escapeHtml(s.transport)}${WEBRTC_OFF ? ' <span class="net-tag">' + tr('bez WebRTC') + '</span>' : ''}</span></div>
    <div class="net-row"><span class="k">${tr('Węzeł (relay)')}</span><span class="v" title="${escapeHtml(s.relay)}">${escapeHtml(relayHost)}${isFailover ? ' <span class="net-tag">' + tr('failover') + '</span>' : ''}</span></div>
    ${nodesRow}
    ${relayPeer ? `<div class="net-row"><span class="k">${tr('PeerId węzła')}</span><span class="v mono">${escapeHtml(relayPeer.slice(0, 14))}…</span></div>` : ''}
    <div class="net-row"><span class="k">${tr('Twój PeerId')}</span><span class="v mono">${escapeHtml(s.self.slice(0, 14))}…</span></div>
    ${capReport && capReport.degraded.length ? `<div class="net-row wrap"><span class="k">${tr('Platforma')}</span><span class="v chips" title="${escapeHtml(capReport.ua)}">`
      + capReport.degraded.map((c) => `<span class="net-node">○ ${escapeHtml(c.id)}</span>`).join('')
      + `</span></div>` : ''}
    <div class="net-row"><span class="k">${tr('Ekran')}</span><span class="v" title="${escapeHtml(navigator.userAgent)}">`
      + `${window.innerWidth}×${window.innerHeight} · ${window.devicePixelRatio || 1}× · `
      + `${matchMedia('(max-width:900px),(max-height:560px)').matches ? tr('układ telefonu') : tr('układ pulpitu')}</span></div>
    <div class="net-row"><span class="k">${tr('Topiki')}</span><span class="v">${s.topics.length} <span class="net-sub">(grupy: ${gCount} · pary/self: ${s.topics.length - gCount})</span></span></div>
  </div>
  <div class="net-note">${candidates.length > 1
    ? tr('Failover po liście węzłów: gdy pierwszy węzeł nie odpowiada, sesja przechodzi na następny. Węzły są zmeshowane, więc przełączenie nie dzieli rozmówców.')
    : tr('Wszystkie topiki na jednym połączeniu. Więcej węzłów (i failover) dodasz z edytowalnej listy w oknie logowania.')}</div>`
}
function startNetwork() { renderNetwork(); clearInterval(netTimer); netTimer = setInterval(renderNetwork, 2500) }
function stopNetwork() { clearInterval(netTimer); netTimer = null }

// ---- chat ----
const msgEls = new Map<string, HTMLElement>() // msg id → its reactions container (both directions share the id)
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮']
function addReaction(msgId: string, emoji: string) {
  const rx = msgEls.get(msgId); if (!rx) return
  const chip = document.createElement('span'); chip.className = 'rchip'; chip.textContent = emoji
  rx.appendChild(chip)
}
/**
 * Reading older messages must not be interrupted by new ones. If the view is
 * scrolled up we leave it where it is, show a jump-to-latest button (with a
 * count of what arrived meanwhile) and only follow along when the reader is
 * already at the bottom.
 */
const NEAR_BOTTOM_PX = 80
let unread = 0
const atBottom = () => {
  const box = $('messages')
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX
}
function refreshJump() {
  const show = !atBottom()
  $('to-bottom').hidden = !show
  if (!show) { unread = 0 }
  const badge = $('unread')
  badge.hidden = unread === 0
  badge.textContent = String(unread)
}
function jumpToLatest() {
  const box = $('messages')
  const before = box.scrollTop
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  // Smooth scrolling is an enhancement, not the mechanism. Where it is a no-op
  // — headless Chromium, Firefox with general.smoothScroll off, reduced-motion
  // settings — scrollTo moves nothing and the button appears and then does
  // nothing at all. If the animation has not started by now, land immediately.
  setTimeout(() => {
    if (box.scrollTop === before) box.scrollTop = box.scrollHeight
    // …and re-decide here. The refreshJump() below runs while we are still at
    // the top, so it leaves the button ON; what turns it off is the scroll
    // event — and a scroll set from code does not always produce one (headless
    // Chromium doesn't). Without this the view lands at the newest message and
    // the ⬇ stays on screen over it, pointing nowhere.
    refreshJump()
  }, 300)
  unread = 0
  refreshJump()
}
$('messages').addEventListener('scroll', refreshJump)
$('to-bottom').addEventListener('click', jumpToLatest)

/** msg id → the little delivery marker under our own bubble. */
const stateEls = new Map<string, HTMLElement>()
function setDelivery(id: string, state: 'ok' | 'lost' | 'late', ms?: number) {
  const el = stateEls.get(id)
  if (!el) return
  if (state === 'ok') {
    el.textContent = tr(' · ✓ ') + tr('dostarczone')
    el.title = tr('Klient rozmówcy potwierdził odbiór{when} — to nie jest „przeczytane”', { when: ms !== undefined ? tr(' po {ms} ms', { ms }) : '' })
  } else if (state === 'late') {
    // It said ⚠, and it was wrong: the confirmation came in after we had given
    // up. Say so plainly rather than quietly flipping it to a clean ✓ — the
    // long gap is exactly the thing worth noticing.
    el.textContent = ` · ⏱ ${tr('dostarczone z opóźnieniem')}${ms !== undefined ? ` (${Math.round(ms / 1000)}s)` : ''}`
    el.title = tr('Potwierdzenie przyszło już po tym, jak przestaliśmy ponawiać — wiadomość jednak dotarła')
    el.classList.add('late')
  } else {
    el.textContent = tr(' · ⚠ niedostarczone')
    el.title = tr('Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał')
    // The transport gave up; give the decision back to the user instead of
    // leaving a dead ⚠ that can only be fixed by retyping the message.
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'b-resend'
    again.textContent = tr('↻')
    again.title = tr('Wyślij ponownie')
    again.addEventListener('click', () => {
      if (!activeRoom()?.conv?.resend(id)) return
      el.textContent = tr(' · wysyłam ponownie…')
      el.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
    })
    el.appendChild(again)
  }
}

/**
 * Put a straggler where it was written. The transcript is otherwise strictly
 * append-order, which is a lie the moment the transport reorders: the message
 * the peer typed first shows up under two that came after it, and a reader
 * following a conversation reads the answer before the question.
 *
 * Placement is by the sender's own clock (`ts` on the envelope), scanning back
 * from the end — recent messages are where a straggler lands, and an unbounded
 * walk over a long transcript is not worth it for a rare event.
 */
const REORDER_LOOKBACK = 60
function insertByTime(box: HTMLElement, row: HTMLElement, ts: number) {
  const rows = box.children
  let at: Element | null = null
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < REORDER_LOOKBACK; i--, seen++) {
    const prev = rows[i] as HTMLElement
    const prevTs = Number(prev.dataset?.ts ?? 0)
    if (!prevTs) continue // sysline or something without a clock — skip over it
    if (prevTs <= ts) break // everything from here back is older: we go after it
    at = prev
  }
  box.insertBefore(row, at)
}

function appendMsg(kind: 'me' | 'peer' | 'sys', text: string, ts?: number, id?: string, outOfOrder = false, who?: string, sent = false) {
  const box = $('messages')
  if (kind === 'sys') {
    const stick = atBottom()
    const s = document.createElement('div'); s.className = 'sysline'; s.textContent = text; box.appendChild(s)
    if (stick) box.scrollTop = box.scrollHeight
    return
  }
  const stick = (atBottom() && !outOfOrder) || kind === 'me' // sending always follows your own message
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  row.dataset.ts = String(ts ?? nowMs())
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') { const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w) }
  const t = document.createElement('div'); t.className = 'b-text'; renderBody(t, text)
  const m = document.createElement('div'); m.className = 'b-meta'; m.textContent = utcHHMM(ts ?? nowMs()) + ' UTC'
  if (outOfOrder) {
    // Same ⏱ as a late confirmation on our own side: one mark, one meaning —
    // "this one did not travel normally".
    const late = document.createElement('span'); late.className = 'late-mark'; late.textContent = tr(' ⏱ spóźniona')
    late.title = tr('Dotarła po nowszych wiadomościach — wstawiona w miejscu, w którym została napisana')
    m.appendChild(late)
  }
  if (kind === 'me' && id) {
    // Delivery state for our own messages. Instant-only: this says the peer's
    // client holds it, never that anyone read it.
    const st = document.createElement('span'); st.className = 'b-state'
    if (sent) {
      // A group broadcast: fire-and-forget over GossipSub, no per-recipient acks —
      // so it is "sent", never the 1:1 "sending…→delivered" that would hang here.
      st.textContent = tr(' · wysłano'); st.title = tr('Wysłane do grupy (broadcast — bez potwierdzeń doręczenia)')
    } else {
      st.textContent = tr(' · wysyłam…'); st.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
      stateEls.set(id, st) // only 1:1 gets delivery updates
    }
    m.appendChild(st)
  }
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(t, m, rx); row.appendChild(bub)
  if (id) {
    msgEls.set(id, rx)
    attachReactionBar(row, id)
    // Touch has no hover: tap the bubble to reveal its reaction bar (one row at a
    // time), tap again to hide. On desktop hover still shows it; this just adds a
    // way in for fingers without a permanently-visible bar on every message.
    bub.addEventListener('click', (e: any) => {
      if (e.target.closest('button')) return // a control inside the bubble (e.g. ↻ resend), not a reveal
      const open = row.classList.contains('tapped')
      for (const r of $('messages').querySelectorAll('.mrow.tapped')) r.classList.remove('tapped')
      if (!open) row.classList.add('tapped')
    })
  }
  if (outOfOrder) insertByTime(box, row, Number(row.dataset.ts))
  else box.appendChild(row)
  if (stick) { box.scrollTop = box.scrollHeight; unread = 0 }
  else if (kind === 'peer') unread++
  refreshJump()
}
const setTyping = (on: boolean, name = '') => { $('typing-ind').textContent = on ? `${name} pisze…` : '' }
/** `?debug=1` adds per-frame lines (every handshake frame, every sealed payload). */
const DEBUG = new URLSearchParams(location.search).has('debug')

/**
 * The engine narrates itself here (lib/room.ts, lib/core.ts) — everything that
 * decides whether a room forms: when the relay picked up our topic, when a peer
 * became visible, every handshake attempt and its outcome, presence timeouts,
 * queued frames. This is the log to paste when "it does not work": the badge
 * only ever shows the last state, while the sequence is what explains it.
 */
const t0 = Date.now()
function ecLog(msg: string, level: 'info' | 'debug' = 'info') {
  if (level === 'debug' && !DEBUG) return
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6)
  const style = level === 'debug' ? 'color:#79829c' : 'color:#6579e0;font-weight:600'
  console.log(`%c[ec ${t}s] %c${msg}`, 'color:#74788d', style)
}
ecLog(`app start — debug=${DEBUG} transport=${USE_MQTT ? `mqtt (${BROKER})` : 'libp2p'}`
  + ` rotation=${FORCED_ROTATION_SEC == null ? 'per-pair offset' : `forced ${String(Math.floor(FORCED_ROTATION_SEC / 3600)).padStart(2, '0')}:${String(Math.floor((FORCED_ROTATION_SEC % 3600) / 60)).padStart(2, '0')} UTC`};`
  + ' add ?debug=1 for the full trace, ?mqtt=1 for the broker transport, ?rot=<hour> to force the rollover time')

/**
 * What this platform can actually do, checked before anything needs it.
 *
 * WebKitGTK is why this exists: the desktop webview has X25519 but no WebRTC,
 * and discovering that cost a debugging session instead of a line of output.
 * Every webview is a different subset — Android's Chromium tracks the Play
 * Store rather than the OS version, iOS is whatever WebKit the system shipped —
 * so this asks the platform instead of inferring from a version number.
 *
 * A missing REQUIRED capability stops the app with the reason. Refusing to
 * start is the honest outcome: without X25519 there is no rendezvous and no
 * handshake, and carrying on presents as a conversation that never connects,
 * which is indistinguishable from a network problem and sends the user hunting
 * in the wrong place.
 */
let capReport: Awaited<ReturnType<typeof probeCapabilities>> | null = null
void (async () => {
  const rep = await probeCapabilities()
  capReport = rep
  renderNetwork() // a phone has no console — the Network tab is where this is readable
  ecLog(formatReport(rep))
  for (const d of rep.degraded) ecLog(`capability (degraded): ${d.id} — ${d.note}`)
  if (rep.ok) return
  const card = document.querySelector('.login-card')
  if (!card) return
  card.innerHTML = `<h1>${escapeHtml(tr('Ta przeglądarka nie wystarczy'))}</h1>`
    + `<div class="sub">${escapeHtml(tr('Encedo Chat potrzebuje kilku funkcji, których tu brakuje. Bez nich nie da się nawet ustalić wspólnego pokoju, więc logowanie jest wyłączone.'))}</div>`
    + rep.missing.map((m) => `<div class="msg err" style="display:block">${escapeHtml(m.id)} — ${escapeHtml(m.note ?? '')}</div>`).join('')
    + `<div class="nodes-hint" style="margin-top:14px">${escapeHtml(rep.ua)}</div>`
})()

/**
 * Per-peer handshake state. The badge shows ONE thing, but a room can have more
 * than one peer id in it — a peer that reloaded, or a second tab logged into the
 * same identity, which can never complete a handshake with us. Rendering
 * whichever event came last made the badge flicker 🔐 → ⚠ → 🔐 while a perfectly
 * good session was carrying messages. The best state wins instead: if any peer
 * has a live ratchet, we are secure, whatever the others are doing.
 */
/** Update a room's security map, then paint the badge if that room is on screen.
 *  The map is per-room now: a background handshake must not move the foreground
 *  badge. On switching in, `paintSecurity` repaints from the room's own map. */
function noteSecurity(room: Room, peer: string, state: 'handshaking' | 'established' | 'failed') {
  if (peer) room.security.set(peer, state)
  else { room.security.clear(); room.security.set('', state) }
  if (room === activeRoom()) paintSecurity(room)
}
function paintSecurity(room: Room) {
  const states = [...room.security.values()]
  const best = states.includes('established') ? 'established'
    : states.includes('handshaking') ? 'handshaking' : states.length ? 'failed' : 'handshaking'
  const b = $('e2e-badge')
  if (best === 'established') setBadge(b, 'badge direct', tr('🔐 Secure'), tr('Handshake EH-2 uzgodniony — forward secrecy per wiadomość, hybryda PQ (ML-KEM-768)'))
  else if (best === 'handshaking') setBadge(b, 'badge e2e', tr('🤝 Securing…'), tr('Trwa uzgadnianie klucza sesji (msg1→msg2→msg3)'))
  else setBadge(b, 'badge e2e', tr('⚠️ Not secure'), tr('Handshake nie doszedł do skutku — ponowi się przy następnym Announce'))
}

/**
 * Set a badge as icon + text, not one string.
 *
 * A phone header cannot fit three badges and a name, and hiding them outright
 * would drop the security state — the one thing that must stay visible. Split
 * so CSS can collapse the words on a narrow screen and leave the glyph; the
 * full wording survives in the tooltip. (A `::first-letter` trick was tried and
 * does not work: `.badge` is inline-flex, and that pseudo-element only applies
 * to block containers.)
 */
function setBadge(el: HTMLElement, cls: string, label: string, title: string) {
  const sp = label.indexOf(' ')
  const icon = sp > 0 ? label.slice(0, sp) : label
  const text = sp > 0 ? label.slice(sp + 1) : ''
  el.className = cls
  el.innerHTML = `<span class="b-ico">${escapeHtml(icon)}</span>${text ? `<span class="b-txt">${escapeHtml(text)}</span>` : ''}`
  el.title = title
}

function noteTransport(room: Room, state: string) {
  // `demoted=` belongs here too: a stall hands content back to GossipSub for the
  // rest of the conversation, and the badge claimed Direct throughout because
  // this matcher only knew the `conn=` vocabulary. Anything that is not
  // `conn=connected` paints Relay, which is the safe direction to be wrong in.
  if (/^(conn=(connected|failed|disconnected|closed)|demoted=)/.test(state)) room.transport = state
  if (room === activeRoom()) paintTransport(room)
}
function paintTransport(room: Room) {
  const b = $('transport-badge')
  if (room.transport.startsWith('conn=connected')) setBadge(b, 'badge direct', tr('🟢 Direct'), tr('Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing'))
  else setBadge(b, 'badge relay', tr('⚪ Relay'), tr('Treść przez relay (GossipSub)'))
}


/**
 * The quick-reaction bar, for any bubble that has an id.
 *
 * Shared because it has to be: it is attached to messages and to files, in 1:1
 * rooms and in groups, and the version this replaced knew only about
 * `activeRoom()` — which is null whenever a group is on screen, so the bar was
 * inert in every group without anything saying so.
 */
function attachReactionBar(row: HTMLElement, id: string) {
  const bar = document.createElement('div'); bar.className = 'b-react'
  for (const e of QUICK_EMOJI) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = e
    btn.addEventListener('click', () => {
      row.classList.remove('tapped')
      if (activeGid) {
        const gu = groupsUI.get(activeGid); if (!gu?.room) return
        void gu.room.sendReaction(id, e)
        recordGroup(gu, { t: 'react', id, emoji: e })
      } else {
        const r = activeRoom(); if (!r?.conv) return
        r.conv.sendReaction(id, e)
        record(r, { t: 'react', id, emoji: e })
      }
    })
    bar.appendChild(btn)
  }
  row.appendChild(bar)
}

// ---- files ----------------------------------------------------------------
/** A file bubble: icon, name, size, and one action. Rendered like any other
 *  event so switching rooms replays it from the log. */
function appendFile(kind: 'me' | 'peer', env: FileEnv, ts: number, who?: string) {
  const box = $('messages')
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') {
    const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w)
  }
  const wrap = document.createElement('div'); wrap.className = 'b-file' + (fileGone(env) ? ' gone' : '')
  const ico = document.createElement('span'); ico.className = 'f-ico'; ico.textContent = '📄'
  const info = document.createElement('div'); info.className = 'f-info'
  const name = document.createElement('div'); name.className = 'f-name'; name.textContent = env.name; name.title = env.name
  const sub = document.createElement('div'); sub.className = 'f-sub'
  sub.textContent = humanSize(env.size) + (fileGone(env) ? ' · ' + tr('wygasł') : '')
  info.append(name, sub)
  const act = document.createElement('button'); act.className = 'f-act'
  // No cid yet means it is still being encrypted or uploaded: the button shows
  // that state instead of offering a download that cannot work. attachFile
  // updates these two elements as it goes, via `fileEls`.
  const pending = !env.cid
  act.textContent = pending ? tr('Wysyłam…') : fileGone(env) ? tr('Wygasł') : tr('Pobierz')
  act.disabled = pending || fileGone(env)
  if (!pending) act.addEventListener('click', () => void downloadFile(env, act))
  fileEls.set(env, { act, sub })
  wrap.append(ico, info, act)
  bub.appendChild(wrap)

  // The caption goes through the SAME renderer as a message body — text nodes
  // and link arrows, never markup. A second way of showing user text is how the
  // two drift apart and one of them ends up interpreting something.
  if (env.body) {
    const cap = document.createElement('div'); cap.className = 'b-text b-caption'
    renderBody(cap, env.body)
    bub.appendChild(cap)
  }

  const meta = document.createElement('div'); meta.className = 'b-meta'; meta.textContent = utcHHMM(ts) + ' UTC'
  // Reactions need both halves: somewhere to draw them, and an entry in msgEls
  // so an incoming reaction can find this bubble. appendFile had neither, which
  // is why files could not be reacted to at all.
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(meta, rx)
  if (env.id) msgEls.set(env.id, rx)
  row.appendChild(bub)
  if (env.id) attachReactionBar(row, env.id)
  box.appendChild(row)
  refreshJump()
}


/** How long the store keeps an upload. Advisory: the fetch is what decides, and
 *  the node collects within a minute of expiry — so this is used to grey a
 *  bubble out, never to claim precision the mechanism does not have. */
const FILE_TTL_MS = 5 * 60_000

/**
 * A pending file's action button and subtitle, so an upload in flight can keep
 * them current. Keyed by the envelope OBJECT: the same object is what the room
 * log holds, so mutating it in place and repainting these two elements is all
 * it takes for the bubble to become the finished one — no id to reconcile, and
 * nothing left behind if the room is switched away and replayed.
 */
const fileEls = new WeakMap<FileEnv, { act: HTMLButtonElement; sub: HTMLElement }>()

const humanSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`

/**
 * Encrypt a file, upload the ciphertext, and send the metadata down whichever
 * conversation is on screen.
 *
 * The order is the point: the bytes are ciphertext before they leave the
 * device, and everything needed to read them — key, name, type, chunking —
 * travels in the envelope over the ratchet or a group sender key. The store
 * gets a nameless blob and its size, and holds it for minutes.
 */
async function attachFile(f: File) {
  const gid = activeGid
  const room = gid ? null : activeRoom()
  if (!gid && !room?.conv) return
  if (f.size > MAX_FILE) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return }

  // Whatever is in the composer travels WITH the file, as one message. Taken
  // and cleared now, before the encrypt/upload await, so what is sent is what
  // the user saw when they picked the file — not whatever they typed since.
  const inp = $('msg-input') as HTMLInputElement
  const caption = inp.value.trim()
  inp.value = ''

  // The bubble appears NOW, before any work — on an 80 MB file the encrypt and
  // upload take long enough that a line of system text is indistinguishable
  // from a freeze. It is the same bubble that will hold the finished file; only
  // its action changes, from a progress label to Download.
  const pending: FileEnv = {
    v: 1, t: 'file', id: '', ts: nowMs(), seq: 0,
    cid: '', name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
    key: '', chunk: 0, chunks: 0, alg: '',
    ...(caption ? { body: caption } : {}),
  } as unknown as FileEnv
  if (gid) recordGroup(groupsUI.get(gid)!, { t: 'file', kind: 'me', ts: pending.ts, file: pending })
  else record(room!, { t: 'file', kind: 'me', ts: pending.ts, file: pending })

  const show = (label: string, sub?: string) => {
    const els = fileEls.get(pending); if (!els) return
    els.act.textContent = label
    if (sub !== undefined) els.sub.textContent = sub
  }
  const pct = (a: number, b: number) => b > 0 ? Math.round((a / b) * 100) : 0

  try {
    const key = newFileKey()
    const plain = new Uint8Array(await f.arrayBuffer())
    const { manifest, cipher } = await encryptBytes(key, plain, undefined,
      (done, total) => show(tr('Szyfruję…'), `${humanSize(f.size)} · ${pct(done, total)}%`))
    const { cid } = await putBlob(cipher, {
      onProgress: (sent, total) => show(tr('Wysyłam…'), `${humanSize(f.size)} · ${pct(sent, total)}%`),
    })
    ;(window as any).__lastFileCid = cid // read by the browser harness; harmless elsewhere
    const meta = {
      cid, name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
      key: b64(key), chunk: manifest.chunk, chunks: manifest.chunks, alg: manifest.alg,
      exp: nowMs() + FILE_TTL_MS,
      ...(caption ? { body: caption } : {}),
    }
    // Fill the SAME object the log already holds, so the pending bubble becomes
    // the finished one and a replay after switching rooms shows the real file.
    Object.assign(pending, meta)
    pending.id = gid ? await groupsUI.get(gid)!.room!.sendFile(meta) : room!.conv!.sendFile(meta)
    if (pending.id) msgEls.set(pending.id, fileEls.get(pending)?.act.closest('.bubble')?.querySelector('.b-reactions') as HTMLElement)
    show(tr('Pobierz'), humanSize(f.size))
    const els = fileEls.get(pending)
    if (els) { els.act.disabled = false; els.act.onclick = () => void downloadFile(pending, els.act) }
  } catch (e: any) {
    ecLog('file upload failed: ' + (e?.message ?? e))
    show(tr('Błąd'), tr('nie wysłano'))
    fileEls.get(pending)?.act.closest('.b-file')?.classList.add('gone')
  }
}

/** Has this file outlived the store's retention? Advisory — the fetch decides. */
const fileGone = (f: FileEnv) => !!f.exp && nowMs() > f.exp

/**
 * Fetch, decrypt, and hand the result to the browser as a download.
 *
 * A file that is no longer there is not an error: this store drops uploads
 * after minutes by design, so the user is told to ask for it again rather than
 * to retry something that will never work.
 */
async function downloadFile(env: FileEnv, btn: HTMLButtonElement) {
  const was = btn.textContent
  btn.disabled = true; btn.textContent = tr('Pobieram…')
  try {
    const cipher = await getBlob(env.cid)
    const plain = await decryptBytes(unb64(env.key), { alg: env.alg as any, chunk: env.chunk, chunks: env.chunks, size: env.size }, cipher)
    const url = URL.createObjectURL(new Blob([plain as any], { type: env.mime }))
    const a = document.createElement('a')
    a.href = url; a.download = env.name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    btn.textContent = tr('Zapisano')
  } catch (e: any) {
    const gone = e?.name === 'ExpiredError'
    btn.textContent = gone ? tr('Wygasł') : tr('Błąd')
    btn.closest('.b-file')?.classList.toggle('gone', gone)
    if (!gone) ecLog('file download failed: ' + (e?.message ?? e))
    if (gone) toast(tr('Plik wygasł — poproś o ponowne wysłanie'))
    setTimeout(() => { btn.disabled = false; btn.textContent = was ?? '' }, 2500)
  }
}

// ---- links in a message ---------------------------------------------------
/**
 * Whether the "you are leaving" warning has been silenced for this session.
 *
 * RAM only, by decision: reloading restores it. Persisting a dismissed security
 * warning would outlive the reason someone dismissed it, and this product keeps
 * nothing else across a reload either.
 */
let linkWarnMuted = false

/**
 * Render a message body with its URLs found but NOT clickable — an arrow beside
 * each one opens it.
 *
 * Two properties follow from that split. The text stays a text node, so there
 * is still no path from a message to markup. And what you read is what you
 * would visit: a phishing link works by showing one thing and going to another,
 * and here there is no separate label that could disagree with the target.
 */
function renderBody(into: HTMLElement, text: string) {
  for (const part of splitByLinks(text)) {
    into.appendChild(document.createTextNode(part.text))
    const l = part.link
    if (!l?.href) continue // refused (credentials, bad scheme): text only, no arrow
    const a = document.createElement('a')
    a.className = 'lnk' + (l.warn ? ' warn' : '')
    // The conventional "opens elsewhere" mark: a box with an arrow leaving it.
    // Drawn, not typed — no font has a glyph everyone renders the same way, and
    // this is our own constant markup, never message content.
    a.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"'
      + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>'
      + '<path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>'
    a.href = l.href
    a.target = '_blank'
    // noopener: the opened page must not reach back into this window.
    // no-referrer: otherwise the destination learns you came from here, which is
    // exactly the kind of metadata the rest of this app works to avoid.
    a.rel = 'noopener noreferrer'
    a.referrerPolicy = 'no-referrer'
    const host = l.asciiHost ?? new URL(l.href).host
    a.title = l.warn === 'idn'
      ? tr('Otwórz — uwaga, adres używa znaków spoza ASCII; przeglądarka pójdzie do {host}', { host })
      : tr('Otwórz {host} w nowej karcie', { host })
    a.addEventListener('click', async (e) => {
      if (linkWarnMuted) return // muted for this session: let the browser open it
      e.preventDefault()
      const warn = l.warn === 'idn'
        ? tr('Ten adres używa znaków spoza ASCII i może udawać inny. Przeglądarka otworzy: {host}.', { host }) + ' '
        : ''
      const r = await ask(tr('Otworzyć link?'),
        warn + tr('Wyjdziesz poza aplikację. Strona {host} pozna Twój adres IP i czas wejścia — tego rozmowa nie ujawnia.', { host }),
        tr('Otwórz'), tr('Nie pokazuj tego ostrzeżenia ponownie'), l.href)
      if (r.remember) linkWarnMuted = true
      // Nothing opens here: the dialog's affirmative control IS the link, so the
      // browser navigates on the user's click and no popup blocker is involved.
    })
    into.appendChild(a)
  }
}

/** Record one event on a room's log; render it if that room is on screen,
 *  otherwise (background) just count it and light the dot. Replaying the log
 *  through applyEv reconstructs the transcript exactly. */
const record = (room: Room, ev: Ev) => {
  room.log.push(ev); if (room.log.length > LOG_CAP) room.log.shift()
  if (isViewing(room)) applyEv(ev)
  else if (ev.t === 'msg' && ev.kind === 'peer') { room.unseen++; renderContacts() }
}
function applyEv(ev: Ev) {
  if (ev.t === 'msg') appendMsg(ev.kind, ev.text, ev.ts, ev.id, ev.ooo, ev.who, ev.sent)
  else if (ev.t === 'react') addReaction(ev.id, ev.emoji)
  else if (ev.t === 'delivery') setDelivery(ev.id, ev.state, ev.ms)
  else if (ev.t === 'file') appendFile(ev.kind, ev.file, ev.ts, ev.who)
  else appendMsg('sys', ev.text)
}

/**
 * Show a room that is already open. No teardown, no rebuild of the conversation
 * — clear the transcript DOM and REPLAY the room's log, then repaint the header
 * from the room's own snapshots. This subsumes the old "return to a room" path
 * that once desynced by calling leave() (the ratchet came back after N seconds,
 * one side flipped to Relay): switching between rooms now never touches any
 * conversation, so there is nothing to tear down.
 */
async function activateRoom(pub: string) {
  const room = rooms.get(pub); if (!room) return
  // Only when the target actually changes — activateRoom also runs for the room
  // already on screen (clicking the same peer, a repaint), and wiping a draft
  // then would be a bug rather than a precaution.
  const sameTarget = activePub === pub
  activePub = pub; activeGid = null // a 1:1 takes the screen — no group is active
  if (!sameTarget) clearComposer()
  $('members-cluster').hidden = true; $('members-pop').hidden = true // group-only UI
  room.unseen = 0
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  $('peer-avatar').textContent = initials(room.contact.name)
  $('peer-name').textContent = room.contact.name
  // The peer is identified the same way we identify ourselves: 8-byte
  // fingerprint (comparable out of band) plus the HSM key id when it has one.
  const peerFp = fpCache.get(room.contact.pub) ?? await fingerprint(room.contact.pub)
  fpCache.set(room.contact.pub, peerFp)
  $('sess-peer').textContent = tr('🔑 ') + peerFp + (room.contact.kid ? ' · KID ' + shortKid(room.contact.kid) : '')
  $('sess-peer').title = room.contact.kid ? `KID ${room.contact.kid}` : room.contact.pub
  // The name leads the tooltip now that the header can cut it short; the
  // fingerprint (the out-of-band MITM check) follows, as before.
  $('peer-name').title = `${room.contact.name} · ` + tr('🔑 ') + peerFp + (room.contact.kid ? ` · KID ${room.contact.kid}` : '')
  $('sess-peerid').textContent = room.conv ? room.conv.peerId.slice(0, 16) + '…' : '…'
  // Rebuild the transcript from the log; the module render state (msgEls/stateEls)
  // now describes this room.
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false)
  for (const ev of room.log) applyEv(ev)
  paintSecurity(room); paintTransport(room); paintStatus()
  startRotation(); renderContacts()
  void syncPresence() // foreground changed → light-watch the contact we just left
  void room.conv?.refresh() // re-announce / flush pending — cheap, no teardown
}

/**
 * Open a conversation. `foreground` = the user asked for it (a contact click):
 * show it. Background (an incoming handshake surfaced by presence) opens the
 * room to RECEIVE — the handshake must complete or the message never arrives —
 * but does NOT steal the view: it only lights the unread dot. Idempotent; an
 * already-open room is just re-shown (foreground) or left alone (background).
 */
async function openRoomFor(contact: Contact, foreground: boolean) {
  if (!session) return
  if (rooms.has(contact.pub)) { if (foreground) await activateRoom(contact.pub); return }

  const room: Room = {
    contact, conv: null, log: [], unseen: 0, inRoom: false,
    security: new Map([['', 'handshaking']]), transport: '', peerLabel: tr('łączę…'), lastPresence: null,
  }
  rooms.set(contact.pub, room)
  record(room, { t: 'sys', text: tr('Pokój otwarty — czekam na {name}…', { name: contact.name }) })
  if (foreground) await activateRoom(contact.pub)
  else renderContacts()

  try {
    let peerTyping = false
    let warnedForeign = false
    const conv = await (await clientReady!).open({ pub: contact.pub, kid: contact.kid }, {
      webrtc: !WEBRTC_OFF,
      onWebrtcState: (s) => noteTransport(room, s),
      onSecurity: (peer, state) => noteSecurity(room, peer, state),
      onLog: ecLog,
      onDelivered: (id, ms) => record(room, { t: 'delivery', id, state: 'ok', ms }),
      onUndelivered: (id) => record(room, { t: 'delivery', id, state: 'lost' }),
      onLateDelivered: (id, ms) => record(room, { t: 'delivery', id, state: 'late', ms }),
      onMessage: (from, msg, meta) => {
        ecLog(`message from ${from.slice(0, 12)}…: "${msg.body.slice(0, 40)}"${meta.outOfOrder ? ' (out of order)' : ''}`)
        // A message IS activity: a peer that just wrote is not "away". Presence
        // announces lag (a backgrounded tab throttles them), so a stale away/quiet
        // label sat over a live conversation — clear it on any inbound message.
        if (room.lastPresence !== 'active' && room.lastPresence !== 'join') {
          room.lastPresence = 'active'; room.inRoom = true; room.peerLabel = 'w pokoju'
          if (room === activeRoom()) paintStatus()
          renderContacts()
        }
        if (room === activeRoom()) { peerTyping = false; setTyping(false) }
        record(room, { t: 'msg', kind: 'peer', text: msg.body, ts: msg.ts, id: msg.id, ooo: meta.outOfOrder })
      },
      onTyping: (_from, state) => { peerTyping = state === 'start'; if (room === activeRoom()) setTyping(peerTyping, contact.name) },
      onReaction: (_from, r) => record(room, { t: 'react', id: r.to, emoji: r.emoji }),
      onFile: (_from, f) => record(room, { t: 'file', kind: 'peer', ts: nowMs(), file: f }),
      onForeign: () => {
        // The user is the only one who can fix this, so say it in the transcript
        // rather than in a console nobody has open. Two windows on one identity
        // is by far the common cause; a rotated contact key is the other.
        if (!warnedForeign) {
          warnedForeign = true
          record(room, { t: 'sys', text: tr('Uwaga: w tym pokoju jest ktoś, kto nie uwierzytelnia się jako ten kontakt')
            + tr(' — najczęściej druga zakładka zalogowana na tę samą tożsamość. Zamknij jedną z nich.') })
        }
      },
      onPresence: (_peer, ev) => {
        room.inRoom = ev !== 'leave'
        const label = ev === 'join' ? 'w pokoju' : ev === 'active' ? tr('wrócił/a') : ev === 'away' ? 'nieobecny/a'
          : ev === 'quiet' ? tr('brak sygnału') : tr('wyszedł/wyszła')
        // Presence belongs in the header, not in the transcript. Every tab switch
        // flips away→active; only entering and leaving are worth a line, and only
        // when the state really changed.
        if ((ev === 'join' || ev === 'leave') && room.lastPresence !== ev) record(room, { t: 'sys', text: `${contact.name} ${label}` })
        room.lastPresence = ev
        room.peerLabel = ev === 'leave' ? 'poza pokojem' : label
        if (room === activeRoom()) { paintStatus(); if (ev === 'leave') { peerTyping = false; setTyping(false) } }
        renderContacts()
      },
    })
    if (!rooms.has(contact.pub)) { await conv.leave(); return } // room was closed mid-connect
    room.conv = conv
    if (room === activeRoom()) $('sess-peerid').textContent = conv.peerId.slice(0, 16) + '…'
  } catch (e: any) {
    record(room, { t: 'sys', text: tr('Błąd: ') + (e?.message ?? e) })
    if (room === activeRoom()) $('peer-status').textContent = tr('błąd połączenia')
  }
}

/** Close a room for good: leave the conversation (presence:leave, ratchet stop)
 *  and drop it. Used on contact removal — ordinary view switches never close a
 *  room, that is the whole point. Resets the view if the closed room was on it. */
async function closeRoom(pub: string) {
  const room = rooms.get(pub); if (!room) return
  rooms.delete(pub)
  if (activePub === pub) { activePub = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
  try { await room.conv?.leave() } catch {}
}

// The composer targets whichever room is on screen — wired once, not per open.
function sendComposer() {
  const inp = $('msg-input') as HTMLInputElement
  // A pending file takes the composer over. attachFile() reads the caption out
  // of this same input and clears it, so the text goes once, with the file —
  // and the chip is dropped BEFORE the awaits, so what is sent is what the user
  // saw when they pressed Send.
  if (pendingAttach) { const f = pendingAttach; showAttach(null); void attachFile(f); return }
  const t = inp.value.trim(); if (!t) return
  if (activeGid) { // a group is on screen — broadcast to it
    const gu = groupsUI.get(activeGid); if (!gu?.room) return
    inp.value = ''
    gu.room.sendText(t).then((id) => recordGroup(gu, { t: 'msg', kind: 'me', text: t, ts: nowMs(), id, sent: true })).catch((e) => ecLog('group send failed: ' + (e?.message ?? e)))
    return
  }
  const room = activeRoom(); if (!room?.conv) return
  const id = room.conv.sendText(t)
  ecLog(`sent "${t.slice(0, 40)}" (id ${id}); secured peers: ${room.conv.secured().length}`)
  record(room, { t: 'msg', kind: 'me', text: t, ts: nowMs(), id }); inp.value = ''
}
;($('send') as HTMLButtonElement).onclick = sendComposer
;($('msg-input') as HTMLInputElement).oninput = () => activeRoom()?.conv?.noteActivity()
;($('msg-input') as HTMLInputElement).onkeydown = (e: any) => { if (e.key === 'Enter') sendComposer() }

// ---- groups (§8: Sender Keys over the shared topic) ------------------------
// A group is another kind of room in the same chat pane. It reuses the transcript
// (with sender labels via `who`); membership + keys are the engine's (session.groups).
interface GroupUI { gid: string; name: string; epoch: number; members: { pub: string; name: string }[]; room: GroupRoom | null; log: Ev[]; unseen: number }
const groupsUI = new Map<string, GroupUI>()

const memberName = (pub: string): string =>
  session && pub === session.pub ? 'Ty' : (contactsCache.find((c) => c.pub === pub)?.name ?? (fpCache.get(pub) ?? pub.slice(0, 8)))
const groupDisplay = (gu: GroupUI): string =>
  gu.name || gu.members.filter((m) => m.pub !== session?.pub).map((m) => m.name).join(', ') || 'Grupa'

// Overlapping-avatar cluster (inner .ga spans; the caller wraps in .avatar-cluster).
function avatarClusterHTML(members: { pub: string; name: string }[], max = 5): string {
  let html = members.slice(0, max).map((m) => `<span class="ga" title="${escapeHtml(m.name)}">${escapeHtml(initials(m.name))}</span>`).join('')
  if (members.length > max) html += `<span class="ga more">+${members.length - max}</span>`
  return html
}
/** I am the group admin iff I am roster[0] — the creator (createGroup puts self
 *  first, and that order is preserved on the wire, in snapshots and across rekeys). */
const isGroupAdmin = (gu: GroupUI): boolean => !!session && gu.members[0]?.pub === session.pub

// Fill the group members popover: each participant with an online dot. The admin
// (roster[0]) also gets a remove "×" per other member and an add-member picker.
function renderMembersPop(gu: GroupUI) {
  const admin = isGroupAdmin(gu)
  const rows = gu.members.map((m) => {
    const you = m.pub === session?.pub, online = you || onlinePubs.has(m.pub) // you are, by definition, here
    return `<div class="member-row"><div class="gavatar">${escapeHtml(initials(m.name))}</div>`
      + `<span class="m-name">${escapeHtml(m.name)}</span>`
      + `<span class="dot ${online ? 'ok' : ''}" title="${online ? 'online' : 'offline / nieznany'}"></span>`
      + (admin && !you ? `<button class="m-rm" data-rm="${escapeHtml(m.pub)}" title="${tr('Usuń z grupy')}">×</button>` : '')
      + `</div>`
  }).join('')
  let addUI = ''
  if (admin) {
    const eligible = contactsCache.filter((c) => !gu.members.some((m) => m.pub === c.pub))
    const opts = eligible.length
      ? eligible.map((c) => `<button class="m-add-pub" data-add-pub="${escapeHtml(c.pub)}">${escapeHtml(initials(c.name))} ${escapeHtml(c.name)}</button>`).join('')
      : `<div class="m-add-empty">${tr('wszystkie kontakty już w grupie')}</div>`
    addUI = `<div class="m-add-wrap"><button class="m-add-toggle" data-addmember="1">${tr('+ Dodaj członka')}</button>`
      + `<div class="m-add-list" hidden>${opts}</div></div>`
  }
  $('members-pop').innerHTML = `<div class="m-head">${escapeHtml(tr('{n} członków', { n: gu.members.length }))}</div>` + rows + addUI
}

/**
 * Admin changes the roster: rekey (epoch++, new group_secret → new topic, fresh
 * sending key), re-open the group on the new topic, redistribute the SKD to the
 * NEW roster (a removed member is never sent it → cannot derive the new topic or
 * open new messages), and persist. roster[0] (the admin) is preserved so
 * admin-ness stays stable. The other members redistribute their own fresh keys
 * when they receive the new epoch (see onGroupInvite).
 */
async function changeMembers(gid: string, newMembers: { pub: string; name: string }[], note: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  $('members-pop').hidden = true
  try {
    await client.groups.rekey(gid, newMembers.map((m) => ({ pub: m.pub })))
    gu.room?.stop()
    gu.members = newMembers
    gu.epoch++
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    recordGroup(gu, { t: 'sys', text: note })
    await distributeGroup(gid, gu.name) // new roster only → removed member is locked out
    // The HEM marker's roster blob is now stale, and a stale one reconstructs
    // the OLD member set on a recovering device. One HSM call, best effort —
    // a marker that failed to update must not undo a membership change that did.
    client.groups.writeMarker(gid, gu.name).catch((e) => ecLog('marker update failed: ' + (e?.message ?? e)))
    await persistGroups()
    if (activeGid === gid) activateGroup(gid); else renderGroups()
    toast(note)
  } catch (e: any) { ecLog('group rekey failed: ' + (e?.message ?? e)); toast(tr('Nie udało się zmienić składu grupy')) }
}

/**
 * Open the members popover against an arbitrary anchor — used by the group
 * list, where the popover's default position (absolute, inside the chat header)
 * would put it in the wrong pane entirely. Same content, same handlers: the
 * popover is rendered by one function so the list and the header cannot drift.
 */
let popAnchor: HTMLElement | null = null
/**
 * Which group the popover is showing. It used to be implied by `activeGid`,
 * which was fine while the only opener was the open group's own header — but
 * the list can now open it for a group that is NOT on screen, and acting on
 * `activeGid` there would remove a member from the wrong group.
 */
let popMembersGid: string | null = null
function openMembersPopFor(gu: GroupUI, anchor: HTMLElement, ev?: MouseEvent) {
  const pop = $('members-pop')
  if (!pop.hidden && popAnchor === anchor) { pop.hidden = true; popAnchor = null; return } // toggle
  popMembersGid = gu.gid
  renderMembersPop(gu)
  // Open where the pointer is, not where the row starts. The anchor is a whole
  // sidebar row, so its rect pinned the popover to the far left however far
  // right the button actually was. A click gives a real position; touch and
  // keyboard do not, and fall back to the button's own rect.
  const r = anchor.getBoundingClientRect()
  const btn = (ev?.target as HTMLElement | undefined)?.getBoundingClientRect?.()
  pop.hidden = false // measure first: clamping needs the real size, not a guess
  const w = Math.min(pop.offsetWidth || 260, window.innerWidth - 16)
  const h = Math.min(pop.offsetHeight || 300, window.innerHeight - 16)
  const x = ev?.clientX ?? btn?.left ?? r.left
  const y = ev?.clientY ?? btn?.bottom ?? r.bottom
  // Centred under the pointer, then pulled back inside the viewport — the clamp
  // is what keeps it on screen on a phone, where it is nearly as wide as the app.
  pop.style.left = `${Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8))}px`
  pop.style.top = `${Math.max(8, Math.min(y + 8, window.innerHeight - h - 8))}px`
  popAnchor = anchor
}

/** Am I the admin of this group? roster[0] is the creator — the same rule the members popover uses. */
const iAmAdmin = (gu: GroupUI) => gu.members[0]?.pub === session?.pub

/**
 * Rename a group, for everyone.
 *
 * No rekey. The name already travels in the SKD envelope (`name`, app metadata
 * the crypto ignores), and a same-epoch SKD is the ordinary "here is my sender
 * key again" handoff — so re-sending it carries the new name without a new
 * epoch, a new topic, a re-subscribe, or throwing away forward-secret sending
 * chains. Rotating keys to change a label would cost all of that and buy
 * nothing: the label is not a key and is not what the roster MAC protects.
 *
 * Admin-only, and enforced on BOTH sides: any member may legitimately send a
 * same-epoch SKD, so without the receive-side check in `onGroupInvite` any
 * member could rename the group under everyone else.
 */
async function renameGroup(gid: string, name: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  if (!iAmAdmin(gu)) { toast(tr('Tylko administrator grupy może zmienić jej nazwę')); return }
  const before = gu.name
  gu.name = name
  try {
    await distributeGroup(gid, name)   // same epoch: a key handoff that carries the label
    client.groups.writeMarker(gid, name).catch((e) => ecLog('marker update failed: ' + (e?.message ?? e)))
    await persistGroups()
    recordGroup(gu, { t: 'sys', text: `Nazwa grupy zmieniona na „${name}"` })
    if (activeGid === gid) activateGroup(gid); else renderGroups()
    toast(`Grupa to teraz „${name}"`)
  } catch (e: any) {
    gu.name = before; renderGroups()
    toast(tr('Nie udało się zmienić nazwy grupy: ') + (e?.message ?? e))
  }
}

/**
 * Leave a group on THIS device.
 *
 * There is no "delete for everyone", and there deliberately is not: the others
 * hold their own sender keys and their own copy of the group, and nothing in
 * the design lets one client revoke that. Leaving is local — the room stops,
 * the cache entry goes, and the remaining members carry on. Being removed FROM
 * the group is a different act, it belongs to the admin, and it is what the
 * members popover's × does.
 */
async function leaveGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu) return
  gu.room?.stop()
  groupsUI.delete(gid)
  // Same reset the 1:1 path uses when the room on screen goes away.
  if (activeGid === gid) { activeGid = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
  await persistGroups()
  renderGroups()
  toast(tr('Opuszczono grupę „{name}”', { name: gu.name }))
}

/**
 * Dissolve a group — admin only.
 *
 * Three steps, in this order for a reason. Say so on the topic while everyone
 * can still read it; then rekey to a roster of just me, which is the ordinary
 * membership change applied to all of them at once and leaves nobody able to
 * derive the new topic; then destroy the GK, after which no epoch can ever be
 * advanced again, so the group cannot be revived.
 *
 * What it does NOT do is delete anything on their devices — they keep their
 * copy and it goes quiet. Nothing in this design reaches into another client,
 * and the confirm text says so rather than promising a deletion we cannot
 * perform. The notice is a courtesy, not a control: the lockout is the rekey.
 */
async function deleteGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  if (!iAmAdmin(gu)) { toast(tr('Tylko administrator może usunąć grupę')); return }
  try {
    // While the old topic is still theirs to read.
    try { await gu.room?.sendText('🛑 Grupa została usunięta przez administratora.') } catch {}
    await client.groups.deleteGroup(gid)   // rekey to me alone, then destroy the GK
    gu.room?.stop()
    groupsUI.delete(gid)
    if (activeGid === gid) { activeGid = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
    await persistGroups()
    renderGroups()
    toast(tr('Grupa „{name}” usunięta', { name: gu.name }))
  } catch (e: any) {
    ecLog('group delete failed: ' + (e?.message ?? e))
    toast(tr('Nie udało się usunąć grupy: ') + (e?.message ?? e))
  }
}

function renderGroups() {
  const pane = $('pane-groups'); pane.innerHTML = ''
  const add = document.createElement('div'); add.className = 'add-row'
  const btn = document.createElement('button'); btn.className = 'add-btn'; btn.textContent = tr('+ Nowa grupa')
  btn.addEventListener('click', openGroupModal); add.appendChild(btn); pane.appendChild(add)
  if (!groupsUI.size) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = tr('(brak grup — utwórz)'); pane.appendChild(e); return }
  for (const gu of groupsUI.values()) {
    const b = document.createElement('button'); b.className = 'contact' + (activeGid === gu.gid ? ' active' : '') + (gu.unseen ? ' unread' : '')
    const pill = gu.unseen ? `<span class="c-unread">${gu.unseen > 99 ? '99+' : gu.unseen}</span>` : ''
    const admin = iAmAdmin(gu)
    b.innerHTML = `<div class="avatar">👥</div><div class="c-info"><div class="c-name">${escapeHtml(groupDisplay(gu))}</div>`
      + `<div class="c-sub"><span class="avatar-cluster sm">${avatarClusterHTML(gu.members, 4)}</span> ${gu.members.length} · 🔐</div></div>` + pill
      // Admin-only affordances, on the list itself: no need to open a group to
      // manage it. The members button opens the SAME popover the chat header
      // uses — one implementation, so the two cannot drift.
      + (admin ? `<button class="g-edit" data-ren="1" title="${tr('Zmień nazwę grupy')}">✎</button>` : '')
      + (admin ? `<button class="g-edit" data-mem="1" title="${tr('Uczestnicy')}">👥</button>` : '')
      + `<span class="c-x" title="${admin ? tr('Usuń grupę') : tr('Opuść grupę')}">×</span>`
    b.addEventListener('click', async (e: any) => {
      const d = e.target?.dataset ?? {}
      if (d.ren) {
        e.stopPropagation()
        const name = await promptName(tr('Zmień nazwę grupy'), tr('Nazwa zmieni się u wszystkich członków — klucze zostają bez zmian.'), gu.name, 'Nazwa grupy')
        if (name) await renameGroup(gu.gid, name)
        return
      }
      if (d.mem) {
        e.stopPropagation()
        // Anchor the shared popover next to the row it was opened from.
        openMembersPopFor(gu, b, e as MouseEvent)
        return
      }
      if (e.target.classList.contains('c-x')) {
        e.stopPropagation()
        if (admin) {
          if (!(await ask(tr('Usunąć grupę?'), tr('Wszyscy członkowie „{name}” stracą dostęp do nowych wiadomości,', { name: gu.name })
            + tr(' a klucz grupy zostanie skasowany z HEM — grupy nie da się już przywrócić.')
            + tr(' Ich dotychczasowa kopia rozmowy pozostanie u nich; nie da się jej usunąć zdalnie.'), tr('Usuń grupę'))).ok) return
          await deleteGroup(gu.gid)
        } else {
          if (!(await ask(tr('Opuścić grupę?'), tr('„{name}” zniknie z tego urządzenia i przestaniesz odbierać wiadomości.', { name: gu.name })
            + tr(' Pozostali członkowie zachowują grupę — nie da się jej usunąć u nich.'), tr('Opuść'))).ok) return
          await leaveGroup(gu.gid)
        }
        return
      }
      void activateGroup(gu.gid)
    })
    pane.appendChild(b)
  }
}

/** Record a group event: render if the group is on screen, else count it (dot). */
function recordGroup(gu: GroupUI, ev: Ev) {
  gu.log.push(ev); if (gu.log.length > LOG_CAP) gu.log.shift()
  if (activeGid === gu.gid && $('app').classList.contains('chat-open')) applyEv(ev)
  else if (ev.t === 'msg' && ev.kind === 'peer') { gu.unseen++; renderGroups() }
  // A send must be durable at once (a spent counter cannot be reused after a fast
  // reload); a receive is self-healing (the chain re-walks) so it can debounce.
  if (ev.t === 'msg') { if (ev.kind === 'me') void persistGroups(); else schedulePersist() }
}

// ---- persistence: the group's full state survives a reload (§10) -----------
// Each group's full state (material + my sending chain + EVERY member's receiving
// key) is sealed to its own §10-encrypted blob, so a reload continues without
// re-distribution. The at-rest key is anchored to the identity: base = ECDH(IK,
// emp_pub) (one id.ecdh per session; IK stays in the HEM), per-group AES key =
// HKDF(base, gid) — see lib/gcache.ts. One blob per gid: ec-gcache-<handle>-<gid>.
const genc = new TextEncoder()
const empKey = () => 'ec-gcache-emp-' + (session?.handle ?? '')
const gcachePrefix = () => 'ec-gcache-' + (session?.handle ?? '') + '-'
const legacyGroupsKey = () => 'ec-groups-' + (session?.handle ?? '') // B1 plaintext (migrated away)
let cacheBase: Uint8Array | null = null
let persistTimer: any

/** The §10 cache master secret ECDH(IK, emp_pub), computed once and cached. The
 *  emp public key is random and kept in localStorage; IK never leaves the HEM. */
async function ensureCacheBase(): Promise<Uint8Array | null> {
  if (cacheBase) return cacheBase
  if (!session) return null
  let empPub = localStorage.getItem(empKey())
  if (!empPub) { empPub = b64((await generateX25519()).pub); localStorage.setItem(empKey(), empPub) }
  try { cacheBase = await session.id.ecdh(empPub) } catch (e: any) { ecLog('group cache: ecdh(base) failed — ' + (e?.message ?? e), 'debug'); return null }
  return cacheBase
}

/** Seal every group's full state to its own §10 blob. Async; the message path uses
 *  schedulePersist (debounced) for receives, immediate for my own sends. */
async function persistGroups() {
  if (!client || !session || wiping) return // a wipeout must not be undone by the unload flush
  const base = await ensureCacheBase(); if (!base) return
  for (const snap of client.groups.snapshot()) {
    const gidHex = client.groups.gidHexOf(unb64(snap.gid))
    const name = groupsUI.get(gidHex)?.name ?? ''
    try {
      const blob = await sealCache(base, gidHex, genc.encode(JSON.stringify({ snap, name })))
      localStorage.setItem(gcachePrefix() + gidHex, blob)
    } catch (e: any) { ecLog('group persist failed: ' + (e?.message ?? e), 'debug') }
  }
}
function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => void persistGroups(), 1500) }

/** Bring one group back from a decrypted snapshot: engine + UI + re-subscribe. */
async function addRestoredGroup(snap: any, name: string): Promise<string | null> {
  if (!client) return null
  try {
    const [gidHex] = await client.groups.restore([snap])
    if (!groupsUI.has(gidHex)) {
      const members = (snap.roster as { pub: string }[]).map((m) => ({ pub: m.pub, name: memberName(m.pub) }))
      const gu: GroupUI = { gid: gidHex, name: name || 'Grupa', epoch: snap.epoch, members, log: [], unseen: 0, room: null }
      groupsUI.set(gidHex, gu)
      gu.room = await client.openGroup(gidHex, groupHandlers(gidHex))
    }
    return gidHex
  } catch (e: any) { ecLog('group restore failed: ' + (e?.message ?? e), 'debug'); return null }
}

/** Restore groups from the encrypted §10 cache on startup (+ migrate a B1 blob). */
async function restoreGroups() {
  if (!client || !session) return
  const base = await ensureCacheBase(); if (!base) return
  const seen = new Set<string>()
  const prefix = gcachePrefix()
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(prefix)) continue
    const gidHex = k.slice(prefix.length)
    const blob = localStorage.getItem(k); if (!blob) continue
    const pt = await openCache(base, gidHex, blob)
    if (!pt) { ecLog('group cache: decrypt failed for ' + gidHex.slice(0, 8) + '…', 'debug'); continue }
    let parsed: any; try { parsed = JSON.parse(dec.decode(pt)) } catch { continue }
    if (await addRestoredGroup(parsed.snap, parsed.name)) seen.add(gidHex)
  }
  await migrateLegacyGroups(seen)
  renderGroups()
  if (seen.size) ecLog(`restored ${seen.size} group(s) from the encrypted cache`)
}

/** One-time upgrade: a B1 plaintext blob (ec-groups-<handle>) → encrypt each group
 *  into the §10 cache, then delete the plaintext. Prevents groups vanishing on the
 *  B1→B2 upgrade the same way the identity change once broke 1:1. */
async function migrateLegacyGroups(seen: Set<string>) {
  const raw = localStorage.getItem(legacyGroupsKey()); if (!raw || !client) return
  try {
    const blob = JSON.parse(raw); const names = new Map<string, string>(blob.names ?? [])
    for (const snap of blob.groups ?? []) {
      const gidHex = client.groups.gidHexOf(unb64(snap.gid))
      if (!seen.has(gidHex)) { if (await addRestoredGroup(snap, names.get(gidHex) ?? '')) seen.add(gidHex) }
    }
    await persistGroups()                    // re-seal as encrypted blobs
    localStorage.removeItem(legacyGroupsKey()) // drop the plaintext
    ecLog('migrated the B1 plaintext group cache to the §10 encrypted cache')
  } catch (e: any) { ecLog('legacy group migration failed: ' + (e?.message ?? e), 'debug') }
}

/** Show a group in the chat pane (reuses #messages; sender labels via `who`). */
async function activateGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu) return
  const sameTarget = activeGid === gid // as in activateRoom: a new audience empties the composer, a repaint does not
  activeGid = gid; activePub = null // a group takes over — no 1:1 is "active"
  if (!sameTarget) clearComposer()
  gu.unseen = 0
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  $('peer-avatar').textContent = tr('👥')
  $('peer-name').textContent = groupDisplay(gu); $('peer-name').title = ''
  $('peer-dot').className = 'dot ok'; $('peer-status').textContent = tr('{n} członków', { n: gu.members.length })
  // Participant cluster in the header → click to see the full member list.
  const cluster = $('members-cluster'); cluster.hidden = false; cluster.innerHTML = avatarClusterHTML(gu.members)
  cluster.title = tr('Uczestnicy grupy')
  cluster.onclick = (e: any) => { e.stopPropagation(); openMembersPopFor(gu, cluster, e as MouseEvent) }
  $('members-pop').hidden = true
  setBadge($('e2e-badge'), 'badge direct', tr('🔐 Secure'), tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)'))
  $('e2e-badge').title = tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)')
  setBadge($('transport-badge'), 'badge relay', tr('⚪ Relay'), tr('Grupa idzie przez relay (GossipSub) — nie WebRTC'))
  $('transport-badge').title = tr('Grupa idzie przez relay (GossipSub) — nie WebRTC')
  $('sess-peerid').textContent = gid.slice(0, 12) + '…'
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false)
  for (const ev of gu.log) applyEv(ev)
  startRotation(); renderGroups()
}

const groupHandlers = (gid: string) => ({
  onMessage: (from: string, env: { body: string; ts: number; id: string }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'msg', kind: from === session?.pub ? 'me' : 'peer', text: env.body, ts: env.ts, id: env.id, who: memberName(from) }),
  onReaction: (_from: string, r: { to: string; emoji: string }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'react', id: r.to, emoji: r.emoji }),
  // A file in a group is the same envelope as in a 1:1 — every member holds the
  // key it carries, so each fetches the blob itself within its short life.
  onFile: (from: string, f: FileEnv) =>
    recordGroup(groupsUI.get(gid)!, { t: 'file', kind: from === session?.pub ? 'me' : 'peer', ts: nowMs(), file: f, who: memberName(from) }),
  onLog: (m: string) => ecLog('group: ' + m, 'debug'),
})

/** Hand my SKD for `gid` (with the display name) to every other member over 1:1. */
async function distributeGroup(gid: string, name: string) {
  if (!client) return
  for (const m of groupsUI.get(gid)?.members ?? []) {
    if (m.pub === session?.pub) continue
    // Per recipient: when I am the admin, skdFor attaches THIS member's roster MAC
    // (rk from ECDH(GK_priv, IK_m)); a member's own redistribution carries none.
    const skd = await client.groups.skdFor(gid, m.pub); if (!skd) return
    const contact = contactsCache.find((c) => c.pub === m.pub) ?? { name: m.name, pub: m.pub, source: 'local' as const }
    await openRoomFor(contact, false) // ensure a background 1:1 room; sendGroupSkd queues until it is up
    const conv = rooms.get(m.pub)?.conv
    if (conv) conv.sendGroupSkd({ ...skd, name }); else ecLog(`group: 1:1 to ${m.name} not ready — SKD not sent yet`)
  }
}

/** An SKD arrived over some 1:1 (already applied to the engine): join a new group
 *  (and hand my key back once), or update an existing one on a rekey. */
async function onGroupInvite(from: string, skd: GroupSkdEnv) {
  if (!client) return
  const gid = client.groups.gidHexOf(unb64(skd.gid))
  const members = skd.roster.map((pub) => ({ pub, name: memberName(pub) }))
  let gu = groupsUI.get(gid)
  if (!gu) {
    gu = { gid, name: skd.name || 'Grupa', epoch: skd.epoch, members, log: [], unseen: 0, room: null }
    groupsUI.set(gid, gu)
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    toast(tr('Dołączono do grupy „{name}”', { name: groupDisplay(gu) }))
    void distributeGroup(gid, gu.name) // hand my sender key to everyone, once
  } else {
    gu.members = members
    // The name is app metadata the roster MAC does NOT cover, and any member may
    // legitimately send a same-epoch SKD (that is the ordinary sender-key
    // handoff) — so without this check any member could rename the group under
    // everyone else. The admin is roster[0]; who `from` is was authenticated by
    // the 1:1 ratchet the SKD arrived on.
    if (skd.name && from === members[0]?.pub) gu.name = skd.name
    // A newer epoch means a rekey → a new group_secret → a new topic, so the room
    // must re-join. A *same-epoch* SKD is just a member handing us its sender key
    // (already applied to the engine): keep the live room — tearing it down here
    // churns the mesh on every member's join-back and can drop in-flight frames.
    if (skd.epoch > gu.epoch) {
      gu.epoch = skd.epoch
      gu.room?.stop(); gu.room = await client.openGroup(gid, groupHandlers(gid))
      if (activeGid === gid) void activateGroup(gid)
      // A rekey gave the engine a FRESH sending key for us at this epoch, so hand
      // it to the new roster — otherwise only the admin (who redistributed) would
      // be readable after an add/remove. Same-epoch SKDs (the others doing the
      // same) hit the else-branch and do not re-trigger, so this converges.
      void distributeGroup(gid, gu.name)
    }
  }
  renderGroups()
  void persistGroups() // key/membership changed — flush now, not on the debounce
}

// ---- create-group modal ----
function openGroupModal() {
  const list = $('group-members'); list.innerHTML = ''
  if (!contactsCache.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = tr('Najpierw dodaj kontakty — członkowie grupy muszą być kontaktami.'); list.appendChild(e) }
  for (const c of contactsCache) {
    const row = document.createElement('label'); row.className = 'gmember'
    row.innerHTML = `<input type="checkbox" value="${escapeHtml(c.pub)}"><div class="gavatar">${escapeHtml(initials(c.name))}</div><span>${escapeHtml(c.name)}</span>`
    list.appendChild(row)
  }
  ;($('group-name') as HTMLInputElement).value = ''; clr('group-msg')
  $('scrim').classList.add('open'); $('group-modal').classList.add('open'); $('group-name').focus()
}
const closeGroupModal = () => { $('scrim').classList.remove('open'); $('group-modal').classList.remove('open') }
$('group-cancel').addEventListener('click', closeGroupModal)
$('group-create').addEventListener('click', async () => {
  if (!client || !session) return
  const name = val('group-name')
  const picked = [...document.querySelectorAll('#group-members input:checked')].map((el) => (el as HTMLInputElement).value)
  if (!name) { setMsg('group-msg', tr('Podaj nazwę grupy.'), 'err'); return }
  if (!picked.length) { setMsg('group-msg', tr('Wybierz co najmniej jednego członka.'), 'err'); return }
  try {
    const roster = [{ pub: session.pub }, ...picked.map((pub) => ({ pub }))]
    // GK comes from whatever backs this identity (bucket A): a HEM identity mints
    // it inside the HSM, a software one falls back to a scalar. The app does not
    // choose — and must not, or the two paths drift.
    const gid = await client.groups.createGroupWithNewKey(`chat-gk-${name}`.slice(0, 32), roster, name)
    const gu: GroupUI = { gid, name, epoch: 0, members: roster.map((m) => ({ pub: m.pub, name: memberName(m.pub) })), log: [], unseen: 0, room: null }
    groupsUI.set(gid, gu)
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    closeGroupModal()
    await activateGroup(gid)
    void distributeGroup(gid, name) // send the invite (keys) to each member over 1:1
    void persistGroups() // the new group must survive a reload immediately
    toast(tr('Grupa „{name}” utworzona — rozsyłam zaproszenia…', { name }))
  } catch (e: any) { setMsg('group-msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
})

document.addEventListener('visibilitychange', () => {
  ecLog(document.hidden ? 'tab hidden — browser will throttle our timers' : 'tab visible — re-announcing')
  // Every open room, not just the visible one: a background conversation must
  // stay alive across the throttle too. Coming back, the tab's timers were
  // throttled while hidden, so our Announce heartbeat went quiet and the peer may
  // already have written us off — speak up now instead of waiting for the tick.
  for (const r of rooms.values()) { if (document.hidden) r.conv?.noteAway(); else r.conv?.refresh() }
  if (document.hidden) void persistGroups() // best-effort flush on backgrounding (encrypt is async); sends are already durable
})
/**
 * Phone layout: one pane at a time (see the ≤720px rules in index.html). The
 * class is what switches between the contact list and the conversation; on a
 * desktop it changes nothing.
 */
const showChatPane = (on: boolean) => $('app').classList.toggle('chat-open', on)
$('btn-back').addEventListener('click', () => { showChatPane(false); renderContacts() })

/**
 * Keep the app exactly as tall as the VISIBLE viewport.
 *
 * A software keyboard does not resize `100vh` — that is the screen — so the
 * composer ends up underneath it, which is the single most common way a chat
 * app is unusable on a phone. `visualViewport` reports what is actually visible,
 * including while the keyboard animates.
 */
function trackViewport() {
  const vv = window.visualViewport
  const apply = () => {
    const visible = Math.round(vv?.height ?? window.innerHeight)
    // Clamp to the visible area ONLY while a field is focused and something is
    // genuinely covering the screen. `visualViewport` can report a smaller
    // height for other reasons (a headless viewport override does), and shrinking
    // the app to that would waste a third of the screen for no reason.
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
    const covered = window.innerHeight - visible > 120
    document.documentElement.style.setProperty('--app-h', typing && covered ? `${visible}px` : '100dvh')
  }
  apply()
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply) // emulated viewports (and desktops) resize the window, not visualViewport
  document.addEventListener('focusin', apply)
  document.addEventListener('focusout', () => setTimeout(apply, 100))
  window.addEventListener('orientationchange', () => setTimeout(apply, 250))
}

// The browser tells us about the network directly — no need to infer it from
// silence. This is what makes a Wi-Fi drop or a tunnel show up instantly instead
// of after a couple of missed heartbeats.
window.addEventListener('offline', () => {
  ecLog('browser: offline')
  linkState = 'offline'; paintStatus()
  client?.setOffline(true)
})
window.addEventListener('online', () => {
  ecLog('browser: online')
  linkState = 'reconnecting'; paintStatus()
  client?.setOffline(false)
})

// Leaving the page ends the whole session, not just the open room: the §9.1
// watch has to stop announcing, or the next window sees a rival that is already
// gone and closes itself for nothing.
window.addEventListener('beforeunload', () => { void persistGroups(); for (const r of rooms.values()) r.conv?.leave(); client?.close() })

// ---- room rotation countdown — the ACTIVE pair's real instant (midnight+offset) ----
// The topic rotates per pair at `UTC-midnight + rotationOffsetSec` (§5.4), so the
// old "time to next UTC midnight" was both wrong and identical for every contact.
// Each tick reads the on-screen conversation's offset and counts to its rotation.
// Groups rotate per epoch (membership change), not daily, so the badge is hidden
// while a group is on screen.
function startRotation() {
  if (rotTimer) return
  const tick = () => {
    const el = document.getElementById('rot'); if (!el) return
    const badge = el.closest('.badge.rotate') as HTMLElement | null
    const conv = activeGid ? null : activeRoom()?.conv
    if (!conv) { if (badge) badge.style.display = 'none'; return }
    if (badge) badge.style.display = ''
    const now = Date.now()
    const next = nextRotationAfter(now, (conv.rotationOffsetSec ?? 0) * 1000)
    let s = Math.max(0, Math.floor((next - now) / 1000))
    const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60
    // Hours and minutes only. This counts down to a DAILY rotation, so a ticking
    // seconds field was three characters of header — the scarcest space on a
    // phone — spent on precision nobody acts on. Rounded UP, so it never reads
    // 00:00 while there is still time left.
    const mm = s > 0 ? m + 1 : m
    el.textContent = `${String(h + (mm === 60 ? 1 : 0)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
  }
  // Still every second: the value changes on a minute boundary, and polling for
  // it is cheaper than computing when that boundary falls.
  tick(); rotTimer = setInterval(tick, 1000)
}

refreshStatus()
