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
import { hemIdentityFrom, browserSoftwareIdentity, openConversation, hemContactBook, localContactBook, mergedContactBook, localOnlyManager, type Conversation, type Identity, type ContactManager, type Contact } from '../../lib/core.ts'
import { nowMs, utcHHMM } from '../../lib/time.ts'

const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'
let session: { id: Identity; handle: string; pub: string; kid?: string; book: ContactManager } | null = null
let active: { name: string; pub: string; inRoom: boolean; conv: Conversation | null } | null = null
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
  catch { dot.className = 'dot bad'; hint.textContent = 'HEM nieosiągalny (adres / CORS)' }
}
$('hsm').addEventListener('blur', refreshStatus)

// ---- login / register ----
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'
  const reg = mode === 'register'
  $('reg-handle-wrap').hidden = !reg
  $('go').textContent = reg ? 'Zarejestruj' : 'Zaloguj'
  $('toggle-pre').textContent = reg ? 'Masz już konto?' : 'Nie masz konta?'
  $('toggle').textContent = reg ? 'Zaloguj' : 'Zarejestruj tożsamość'
  clr('msg')
})
$('go').addEventListener('click', async () => {
  const url = val('hsm'), pass = val('pass')
  if (!url || !pass) { setMsg('msg', 'Podaj adres HEM i hasło.', 'err'); return }
  const btn = $('go') as HTMLButtonElement
  btn.disabled = true; btn.textContent = '…'; clr('msg')
  try {
    const hem = new HEM(url); await hem.hemCheckin()
    if (mode === 'register') {
      const handle = val('handle'); if (!handle) { setMsg('msg', 'Podaj handle.', 'err'); return }
      const gen = await hem.authorizePassword(pass, 'keymgmt:gen')
      const iat = Math.floor(Date.now() / 1000)
      const { kid } = await hem.createKeyPair(gen, `chat-ik-${handle}`, 'CURVE25519', btoa(`ETSEIC:self,${handle},ik,${iat}`))
      const use = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
      const { pubkey } = await hem.getPubKey(use, kid)
      await enterApp(hemIdentityFrom(hem, kid, handle, pubkey), mergedContactBook(hemContactBook(hem), makeLocalBook(handle, localStorage)), 'HEM', kid)
    } else {
      const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:self,')
      if (!keys.length) { setMsg('msg', 'Brak tożsamości czatu na tym HEM — zarejestruj.', 'err'); return }
      const key = keys[0]; const handle = parseHandle(key.description)
      const use = await hem.authorizePassword(null, `keymgmt:use:${key.kid}`)
      const { pubkey } = await hem.getPubKey(use, key.kid)
      await enterApp(hemIdentityFrom(hem, key.kid, handle, pubkey), mergedContactBook(hemContactBook(hem), makeLocalBook(handle, localStorage)), 'HEM', key.kid)
    }
  } catch (e: any) { setMsg('msg', 'Błąd: ' + (e?.message ?? e), 'err') }
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
    const id = await browserSoftwareIdentity(handle, () => localStorage.getItem('ec-soft-id'), (v) => localStorage.setItem('ec-soft-id', v))
    await enterApp(id, localOnlyManager(makeLocalBook(id.handle, localStorage)), 'Software · dev')
  } catch (e: any) { setMsg('msg', 'Błąd tożsamości software: ' + (e?.message ?? e), 'err') }
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

async function enterApp(id: Identity, book: ContactManager, sourceLabel: string, kid?: string) {
  session = { id, handle: id.handle, pub: id.pub, kid, book }
  $('login').hidden = true; $('app').hidden = false
  $('me-avatar').textContent = initials(id.handle)
  $('me-handle').textContent = id.handle
  const fp = await fingerprint(id.pub)
  $('me-fp').textContent = '🔑 ' + fp
  $('me-fp').title = kid ? `KID ${kid} · dwuklik = kopiuj klucz publiczny` : 'Dwuklik = kopiuj klucz publiczny'
  $('sess-id').textContent = sourceLabel + ' · ' + fp
  $('sess-kid').textContent = kid ?? '— (klucz w przeglądarce)'
  $('sess-kid').title = kid ?? 'Tożsamość programowa — brak klucza w HSM'
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
  catch (e: any) { toast('Błąd listy kontaktów: ' + (e?.message ?? e)) }
  for (const c of contactsCache) if (!fpCache.has(c.pub)) fpCache.set(c.pub, await fingerprint(c.pub))
  renderContacts()
}
function renderContacts() {
  const pane = $('pane-contacts'); pane.innerHTML = ''
  const filter = val('contact-search').toLowerCase()
  const list = contactsCache.filter((c) => !filter || c.name.toLowerCase().includes(filter))
  if (!list.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = filter ? '(brak dopasowań)' : '(brak kontaktów — dodaj peera)'; pane.appendChild(e); return }
  for (const c of list) {
    const inRoom = active?.name === c.name && active?.inRoom
    const src = c.source === 'hem' ? { i: '🔒', t: 'W HEM (trwałe, przenośne)' } : { i: '💻', t: 'Lokalnie (ta przeglądarka)' }
    const b = document.createElement('button'); b.className = 'contact' + (active?.name === c.name ? ' active' : '')
    b.innerHTML = `<span class="dot ${inRoom ? 'ok' : ''}"></span><div class="avatar">${escapeHtml(initials(c.name))}</div>`
      + `<div class="c-info"><div class="c-name">${escapeHtml(c.name)} <span class="src" title="${src.t}">${src.i}</span></div>`
      + `<div class="c-sub" title="${escapeHtml(c.kid ? `KID ${c.kid}` : c.pub)}">🔑 ${escapeHtml(fpCache.get(c.pub) ?? '…')}${c.kid ? ' · KID ' + escapeHtml(shortKid(c.kid)) : ''}</div></div>`
      + `<span class="c-x" title="Usuń">×</span>`
    b.addEventListener('click', async (e: any) => {
      if (e.target.classList.contains('c-x')) {
        e.stopPropagation()
        if (session) { try { await session.book.remove(c) } catch (err: any) { toast('Błąd usuwania: ' + (err?.message ?? err)) } }
        await refreshContacts(); return
      }
      openChat(c)
    })
    pane.appendChild(b)
  }
}
$('contact-search').addEventListener('input', renderContacts)

// ---- add-peer modal ----
const openModal = () => { $('scrim').classList.add('open'); $('add-modal').classList.add('open'); clr('add-msg'); ;($('add-name') as HTMLInputElement).value = ''; ($('add-pub') as HTMLInputElement).value = ''; ;(document.querySelector('input[name="store"][value="hem"]') as HTMLInputElement).checked = true; $('add-name').focus() }
const closeModal = () => { $('scrim').classList.remove('open'); $('add-modal').classList.remove('open') }
$('btn-add').addEventListener('click', openModal)
$('add-cancel').addEventListener('click', closeModal)
$('add-save').addEventListener('click', async () => {
  if (!session) return
  const name = val('add-name'), pub = val('add-pub')
  if (!name || !pub) { setMsg('add-msg', 'Podaj nazwę i klucz.', 'err'); return }
  try { if (Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)).length !== 32) { setMsg('add-msg', 'Klucz nie wygląda na 32-bajtowy X25519 (base64).', 'err'); return } }
  catch { setMsg('add-msg', 'Klucz nie jest poprawnym base64.', 'err'); return }
  const store = (document.querySelector('input[name="store"]:checked') as HTMLInputElement | null)?.value ?? 'hem'
  if (store === 'none') { closeModal(); openChat({ name, pub, source: 'local' }); return } // ephemeral — nothing saved (HEM nor localStorage)
  const persistent = store !== 'local'
  const btn = $('add-save') as HTMLButtonElement; btn.disabled = true; btn.textContent = 'Zapisuję…'
  try {
    const dup = contactsCache.find((c) => c.name === name)
    if (dup) await session.book.remove(dup)   // upsert: replace an existing peer of the same name (any source)
    await session.book.add(name, pub, persistent)
    await refreshContacts()
    closeModal()
  } catch (e: any) { setMsg('add-msg', 'Błąd zapisu: ' + (e?.message ?? e), 'err') }
  finally { btn.disabled = false; btn.textContent = 'Zapisz' }
})

// ---- settings drawer ----
const openDrawer = () => { $('scrim').classList.add('open'); $('drawer').classList.add('open') }
const closeDrawer = () => { $('scrim').classList.remove('open'); $('drawer').classList.remove('open') }
$('btn-settings').addEventListener('click', openDrawer)
$('chip-profile').addEventListener('click', openDrawer)
$('btn-close-drawer').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', () => { closeModal(); closeDrawer() })
$('btn-logout').addEventListener('click', () => location.reload())

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
  toast('Skopiowano klucz publiczny ✓')
}
$('me-fp').addEventListener('dblclick', copyPub)       // double-click fingerprint → copy pubkey
$('sess-id').addEventListener('dblclick', copyPub)     // double-click Tożsamość → copy pubkey

// ---- placeholder tabs ----
for (const [tab, pane] of [['tab-contacts', 'contacts'], ['tab-groups', 'groups'], ['tab-network', 'network']]) {
  $(tab).addEventListener('click', () => {
    for (const t of ['tab-contacts', 'tab-groups', 'tab-network']) $(t).classList.toggle('active', t === tab)
    for (const p of ['contacts', 'groups', 'network']) $('pane-' + p).hidden = (p !== pane)
  })
}

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
function setDelivery(id: string, state: 'ok' | 'lost', ms?: number) {
  const el = stateEls.get(id)
  if (!el) return
  if (state === 'ok') {
    el.textContent = ' · ✓ dostarczone'
    el.title = `Klient rozmówcy potwierdził odbiór${ms !== undefined ? ` po ${ms} ms` : ''} — to nie jest „przeczytane"`
  } else {
    el.textContent = ' · ⚠ niedostarczone'
    el.title = 'Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał'
    // The transport gave up; give the decision back to the user instead of
    // leaving a dead ⚠ that can only be fixed by retyping the message.
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'b-resend'
    again.textContent = '↻'
    again.title = 'Wyślij ponownie'
    again.addEventListener('click', () => {
      if (!active?.conv?.resend(id)) return
      el.textContent = ' · wysyłam ponownie…'
      el.title = 'Czekam na potwierdzenie od klienta rozmówcy'
    })
    el.appendChild(again)
  }
}

function appendMsg(kind: 'me' | 'peer' | 'sys', text: string, ts?: number, id?: string) {
  const box = $('messages')
  if (kind === 'sys') {
    const stick = atBottom()
    const s = document.createElement('div'); s.className = 'sysline'; s.textContent = text; box.appendChild(s)
    if (stick) box.scrollTop = box.scrollHeight
    return
  }
  const stick = atBottom() || kind === 'me' // sending always follows your own message
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  const bub = document.createElement('div'); bub.className = 'bubble'
  const t = document.createElement('div'); t.className = 'b-text'; t.textContent = text
  const m = document.createElement('div'); m.className = 'b-meta'; m.textContent = utcHHMM(ts ?? nowMs()) + ' UTC'
  if (kind === 'me' && id) {
    // Delivery state for our own messages. Instant-only: this says the peer's
    // client holds it, never that anyone read it.
    const st = document.createElement('span'); st.className = 'b-state'; st.textContent = ' · wysyłam…'
    st.title = 'Czekam na potwierdzenie od klienta rozmówcy'
    m.appendChild(st)
    stateEls.set(id, st)
  }
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(t, m, rx); row.appendChild(bub)
  if (id) {
    msgEls.set(id, rx)
    const bar = document.createElement('div'); bar.className = 'b-react'
    for (const e of QUICK_EMOJI) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = e
      btn.addEventListener('click', () => { active?.conv?.sendReaction(id, e); addReaction(id, e) })
      bar.appendChild(btn)
    }
    row.appendChild(bar)
  }
  box.appendChild(row)
  if (stick) { box.scrollTop = box.scrollHeight; unread = 0 }
  else if (kind === 'peer') unread++
  refreshJump()
}
const setTyping = (on: boolean, name = '') => { $('typing-ind').textContent = on ? `${name} pisze…` : '' }
/**
 * EH-2 (§6–7) instead of the interim static key. Opt-in for now — open the app
 * with `?eh2=1` on BOTH sides; mixing modes means the peers cannot read each
 * other (different content crypto entirely).
 */
const EH2 = new URLSearchParams(location.search).has('eh2')
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
ecLog(`app start — eh2=${EH2} debug=${DEBUG}; add ?eh2=1&debug=1 for the full trace`)

function setSecurity(_peer: string, state: 'handshaking' | 'established' | 'failed') {
  const b = $('e2e-badge')
  if (state === 'established') { b.className = 'badge direct'; b.textContent = '🔐 EH-2 + ratchet'; b.title = 'Handshake EH-2 uzgodniony — forward secrecy per wiadomość, hybryda PQ (ML-KEM-768)' }
  else if (state === 'handshaking') { b.className = 'badge e2e'; b.textContent = '🤝 EH-2 handshake…'; b.title = 'Trwa uzgadnianie klucza sesji (msg1→msg2→msg3)' }
  else { b.className = 'badge e2e'; b.textContent = '⚠️ EH-2 nieudany'; b.title = 'Handshake nie doszedł do skutku — ponowi się przy następnym Announce' }
}

function setTransport(state: string) {
  const b = $('transport-badge')
  if (state.startsWith('conn=connected')) { b.className = 'badge direct'; b.textContent = '🟢 WebRTC Direct'; b.title = 'Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing' }
  else if (state.startsWith('conn=failed') || state.startsWith('conn=disconnected') || state.startsWith('conn=closed')) { b.className = 'badge relay'; b.textContent = '⚪ Relay'; b.title = 'Treść przez relay (GossipSub)' }
}

async function openChat(contact: Contact) {
  if (!session) return
  if (active?.conv) { try { await active.conv.leave() } catch {} }
  active = { name: contact.name, pub: contact.pub, inRoom: false, conv: null }
  renderContacts()
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  $('peer-avatar').textContent = initials(contact.name)
  $('peer-name').textContent = contact.name
  // The peer is identified the same way we identify ourselves: 8-byte
  // fingerprint (comparable out of band) plus the HSM key id when it has one.
  const peerFp = fpCache.get(contact.pub) ?? await fingerprint(contact.pub)
  fpCache.set(contact.pub, peerFp)
  $('sess-peer').textContent = '🔑 ' + peerFp + (contact.kid ? ' · KID ' + shortKid(contact.kid) : '')
  $('sess-peer').title = contact.kid ? `KID ${contact.kid}` : contact.pub
  $('peer-name').title = '🔑 ' + peerFp + (contact.kid ? ` · KID ${contact.kid}` : '')
  $('peer-dot').className = 'dot'; $('peer-status').textContent = 'łączę…'
  $('messages').innerHTML = ''; msgEls.clear(); setTyping(false)
  $('transport-badge').className = 'badge relay'; $('transport-badge').textContent = '⚪ Relay'
  if (EH2) setSecurity('', 'handshaking')
  appendMsg('sys', `Pokój otwarty — czekam na ${contact.name}…`)
  startRotation()

  try {
    let peerTyping = false
    let lastPresence: string | null = null
    const conv = await openConversation(session.id, { pub: contact.pub, kid: contact.kid }, {
      relay: RELAY,
      webrtc: true,
      onWebrtcState: setTransport,
      eh2: EH2,
      onSecurity: setSecurity,
      onLog: ecLog,
      onDelivered: (id, ms) => setDelivery(id, 'ok', ms),
      onUndelivered: (id) => setDelivery(id, 'lost'),
      onMessage: (from, msg) => {
        ecLog(`message from ${from.slice(0, 12)}…: "${msg.body.slice(0, 40)}"`)
        peerTyping = false; setTyping(false); appendMsg('peer', msg.body, msg.ts, msg.id)
      },
      onTyping: (_from, state) => { peerTyping = state === 'start'; setTyping(peerTyping, contact.name) },
      onReaction: (_from, r) => addReaction(r.to, r.emoji),
      onFile: (_from, f) => appendMsg('sys', `${contact.name} udostępnił plik: ${f.name} — interim (IPFS TODO)`),
      onPresence: (_peer, ev) => {
        if (active) active.inRoom = ev !== 'leave'
        const label = ev === 'join' ? 'w pokoju' : ev === 'active' ? 'wrócił/a' : ev === 'away' ? 'nieobecny/a' : 'wyszedł/wyszła'
        // Presence belongs in the header, not in the transcript. Every tab
        // switch flips away→active, and writing each one into the conversation
        // buried the actual messages under "nieobecny/a · wrócił/a" noise.
        // Only entering and leaving the room are worth a line, and only when
        // the state really changed.
        if ((ev === 'join' || ev === 'leave') && lastPresence !== ev) appendMsg('sys', `${contact.name} ${label}`)
        lastPresence = ev
        $('peer-dot').className = 'dot ' + (ev === 'join' || ev === 'active' ? 'ok' : ev === 'away' ? 'away' : '')
        $('peer-status').textContent = ev === 'leave' ? 'poza pokojem' : label
        if (ev === 'leave') { peerTyping = false; setTyping(false) }
        renderContacts()
      },
    })
    if (active?.name !== contact.name) { await conv.leave(); return } // switched away mid-connect
    active.conv = conv
    $('sess-peerid').textContent = conv.peerId.slice(0, 16) + '…'

    const send = () => {
      const inp = $('msg-input') as HTMLInputElement; const t = inp.value.trim(); if (!t) return
      const id = conv.sendText(t)
      ecLog(`sent "${t.slice(0, 40)}" (id ${id}); secured peers: ${conv.secured().length}`)
      appendMsg('me', t, nowMs(), id); inp.value = ''
    }
    ;($('send') as HTMLButtonElement).onclick = send
    ;($('msg-input') as HTMLInputElement).oninput = () => conv.noteActivity()
    ;($('msg-input') as HTMLInputElement).onkeydown = (e: any) => { if (e.key === 'Enter') send() }
  } catch (e: any) {
    appendMsg('sys', 'Błąd: ' + (e?.message ?? e))
    $('peer-status').textContent = 'błąd połączenia'
  }
}

document.addEventListener('visibilitychange', () => {
  ecLog(document.hidden ? 'tab hidden — browser will throttle our timers' : 'tab visible — re-announcing')
  if (document.hidden) active?.conv?.noteAway()
  // Coming back: the tab's timers were throttled while hidden, so our Announce
  // heartbeat went quiet and the peer may already have written us off. Speak up
  // immediately instead of waiting for the next tick.
  else active?.conv?.refresh()
})
window.addEventListener('beforeunload', () => { active?.conv?.leave() })

// ---- room rotation countdown (next UTC midnight) ----
function startRotation() {
  if (rotTimer) return
  const tick = () => {
    const el = document.getElementById('rot'); if (!el) return
    const now = new Date()
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    let s = Math.floor((next - now.getTime()) / 1000)
    const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60
    el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  tick(); rotTimer = setInterval(tick, 1000)
}

refreshStatus()
