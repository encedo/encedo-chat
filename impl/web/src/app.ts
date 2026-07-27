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
import { topicFromSecret, announceMacKey, todayUTC } from '../../lib/rendezvous.ts'
import { interimSession } from '../../lib/session.ts'
import { joinChat } from '../../lib/room.ts'
import { createPeer, dial } from '../../net/peer.ts'
import { nowMs, utcHHMM } from '../../lib/time.ts'

const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'
let session: { hem: any; kid: string; handle: string; pub: string } | null = null
let active: { name: string; pub: string; inRoom: boolean; room: any; node: any } | null = null
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
      await enterApp(hem, handle, kid, pubkey)
    } else {
      const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:self,')
      if (!keys.length) { setMsg('msg', 'Brak tożsamości czatu na tym HEM — zarejestruj.', 'err'); return }
      const key = keys[0]; const handle = parseHandle(key.description)
      const use = await hem.authorizePassword(null, `keymgmt:use:${key.kid}`)
      const { pubkey } = await hem.getPubKey(use, key.kid)
      await enterApp(hem, handle, key.kid, pubkey)
    }
  } catch (e: any) { setMsg('msg', 'Błąd: ' + (e?.message ?? e), 'err') }
  finally { const b = $('go') as HTMLButtonElement; b.disabled = false; b.textContent = mode === 'register' ? 'Zarejestruj' : 'Zaloguj' }
})
$('pass').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') ($('go') as HTMLButtonElement).click() })

async function enterApp(hem: any, handle: string, kid: string, pub: string) {
  session = { hem, kid, handle, pub }
  $('login').hidden = true; $('app').hidden = false
  $('me-avatar').textContent = initials(handle)
  $('me-handle').textContent = handle
  const fp = await fingerprint(pub)
  $('me-fp').textContent = '🔑 ' + fp
  $('sess-id').textContent = 'HEM · ' + fp
  renderContacts()
}

// ---- contacts (localStorage, per identity) ----
type Contact = { name: string; pub: string }
const contactsKey = () => 'ec-contacts-' + (session?.handle ?? '_')
const loadContacts = (): Contact[] => { try { return JSON.parse(localStorage.getItem(contactsKey()) || '[]') } catch { return [] } }
const saveContacts = (list: Contact[]) => localStorage.setItem(contactsKey(), JSON.stringify(list))
function upsertContact(name: string, pub: string) { const list = loadContacts().filter((c) => c.name !== name); list.push({ name, pub }); saveContacts(list); renderContacts() }

function renderContacts() {
  const pane = $('pane-contacts'); pane.innerHTML = ''
  const filter = val('contact-search').toLowerCase()
  const list = loadContacts().filter((c) => !filter || c.name.toLowerCase().includes(filter))
  if (!list.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = filter ? '(brak dopasowań)' : '(brak kontaktów — dodaj peera)'; pane.appendChild(e); return }
  for (const c of list) {
    const inRoom = active?.name === c.name && active?.inRoom
    const b = document.createElement('button'); b.className = 'contact' + (active?.name === c.name ? ' active' : '')
    b.innerHTML = `<span class="dot ${inRoom ? 'ok' : ''}"></span><div class="avatar">${escapeHtml(initials(c.name))}</div>`
      + `<div class="c-info"><div class="c-name">${escapeHtml(c.name)}</div><div class="c-sub">${escapeHtml(c.pub.slice(0, 24))}…</div></div><span class="c-x" title="Usuń">×</span>`
    b.addEventListener('click', (e: any) => {
      if (e.target.classList.contains('c-x')) { e.stopPropagation(); saveContacts(loadContacts().filter((k) => k.name !== c.name)); renderContacts(); return }
      openChat(c)
    })
    pane.appendChild(b)
  }
}
$('contact-search').addEventListener('input', renderContacts)

// ---- add-peer modal ----
const openModal = () => { $('scrim').classList.add('open'); $('add-modal').classList.add('open'); clr('add-msg'); ;($('add-name') as HTMLInputElement).value = ''; ($('add-pub') as HTMLInputElement).value = ''; $('add-name').focus() }
const closeModal = () => { $('scrim').classList.remove('open'); $('add-modal').classList.remove('open') }
$('btn-add').addEventListener('click', openModal)
$('add-cancel').addEventListener('click', closeModal)
$('add-save').addEventListener('click', () => {
  const name = val('add-name'), pub = val('add-pub')
  if (!name || !pub) { setMsg('add-msg', 'Podaj nazwę i klucz.', 'err'); return }
  try { if (Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)).length !== 32) { setMsg('add-msg', 'Klucz nie wygląda na 32-bajtowy X25519 (base64).', 'err'); return } }
  catch { setMsg('add-msg', 'Klucz nie jest poprawnym base64.', 'err'); return }
  upsertContact(name, pub); closeModal()
})

// ---- settings drawer ----
const openDrawer = () => { $('scrim').classList.add('open'); $('drawer').classList.add('open') }
const closeDrawer = () => { $('scrim').classList.remove('open'); $('drawer').classList.remove('open') }
$('btn-settings').addEventListener('click', openDrawer)
$('chip-profile').addEventListener('click', openDrawer)
$('btn-close-drawer').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', () => { closeModal(); closeDrawer() })
$('btn-logout').addEventListener('click', () => location.reload())

// ---- placeholder tabs ----
for (const [tab, pane] of [['tab-contacts', 'contacts'], ['tab-groups', 'groups'], ['tab-network', 'network']]) {
  $(tab).addEventListener('click', () => {
    for (const t of ['tab-contacts', 'tab-groups', 'tab-network']) $(t).classList.toggle('active', t === tab)
    for (const p of ['contacts', 'groups', 'network']) $('pane-' + p).hidden = (p !== pane)
  })
}

// ---- chat ----
function appendMsg(kind: 'me' | 'peer' | 'sys', text: string, ts?: number) {
  const box = $('messages')
  if (kind === 'sys') { const s = document.createElement('div'); s.className = 'sysline'; s.textContent = text; box.appendChild(s) }
  else {
    const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
    const bub = document.createElement('div'); bub.className = 'bubble'
    const t = document.createElement('div'); t.className = 'b-text'; t.textContent = text
    const m = document.createElement('div'); m.className = 'b-meta'; m.textContent = utcHHMM(ts ?? nowMs()) + ' UTC'
    bub.appendChild(t); bub.appendChild(m); row.appendChild(bub); box.appendChild(row)
  }
  box.scrollTop = box.scrollHeight
}
const setTyping = (on: boolean, name = '') => { $('typing-ind').textContent = on ? `${name} pisze…` : '' }

async function openChat(contact: Contact) {
  if (!session) return
  if (active) { try { active.room?.stop() } catch {} ; try { await active.node?.stop() } catch {} }
  active = { name: contact.name, pub: contact.pub, inRoom: false, room: null, node: null }
  renderContacts()
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  $('peer-avatar').textContent = initials(contact.name)
  $('peer-name').textContent = contact.name
  $('peer-dot').className = 'dot'; $('peer-status').textContent = 'łączę…'
  $('messages').innerHTML = ''; setTyping(false)
  appendMsg('sys', `Pokój otwarty — czekam na ${contact.name}…`)
  startRotation()

  try {
    const useTok = await session.hem.authorizePassword(null, `keymgmt:use:${session.kid}`)
    const ss: Uint8Array = await session.hem.ecdh(useTok, session.kid, contact.pub)
    const p = { networkId: 'main', dateUTC: todayUTC() }
    const topic = await topicFromSecret(ss, p)
    const keys = { macKey: await announceMacKey(ss, p), session: await interimSession(ss, p) }
    const node = await createPeer(); await dial(node, RELAY)
    if (active?.name !== contact.name) { try { await node.stop() } catch {} ; return } // switched away mid-connect
    $('sess-peerid').textContent = node.peerId.toString().slice(0, 16) + '…'

    let peerTyping = false
    const room = joinChat(node, topic, keys, {
      onMessage: (_from, msg) => { peerTyping = false; setTyping(false); appendMsg('peer', msg.body, msg.ts) },
      onTyping: (_from, state) => { peerTyping = state === 'start'; setTyping(peerTyping, contact.name) },
      onReaction: (_from, r) => appendMsg('sys', `${contact.name}: ${r.emoji}`),
      onFile: (_from, f) => appendMsg('sys', `${contact.name} udostępnił plik: ${f.name} — interim (IPFS TODO)`),
      onPresence: (_peer, ev) => {
        if (active) active.inRoom = ev !== 'leave'
        const label = ev === 'join' ? 'w pokoju' : ev === 'active' ? 'wrócił/a' : ev === 'away' ? 'nieobecny/a' : 'wyszedł/wyszła'
        appendMsg('sys', `${contact.name} ${label}`)
        $('peer-dot').className = 'dot ' + (ev === 'join' || ev === 'active' ? 'ok' : ev === 'away' ? 'away' : '')
        $('peer-status').textContent = ev === 'leave' ? 'poza pokojem' : label
        if (ev === 'leave') { peerTyping = false; setTyping(false) }
        renderContacts()
      },
    })
    active.room = room; active.node = node
    $('peer-status').textContent = 'w pokoju? — czekam…'

    let typingSent = false, away = false, tT: any, aT: any
    const stopTyping = () => { clearTimeout(tT); if (typingSent) { typingSent = false; room.sendTyping('stop') } }
    const armAway = () => { clearTimeout(aT); aT = setTimeout(() => { away = true; stopTyping(); room.sendPresence('away') }, 60_000) }
    const activity = () => { if (away) { away = false; room.sendPresence('active') } if (!typingSent) { typingSent = true; room.sendTyping('start') } clearTimeout(tT); tT = setTimeout(stopTyping, 4_000); armAway() }
    const send = () => { const inp = $('msg-input') as HTMLInputElement; const t = inp.value.trim(); if (!t) return; room.sendText(t); appendMsg('me', t, nowMs()); inp.value = ''; stopTyping() }
    ;($('send') as HTMLButtonElement).onclick = send
    ;($('msg-input') as HTMLInputElement).oninput = activity
    ;($('msg-input') as HTMLInputElement).onkeydown = (e: any) => { if (e.key === 'Enter') send() }
  } catch (e: any) {
    appendMsg('sys', 'Błąd: ' + (e?.message ?? e))
    $('peer-status').textContent = 'błąd połączenia'
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden && active?.room) { try { active.room.sendPresence('away') } catch {} } })
window.addEventListener('beforeunload', () => { if (active?.room) { try { active.room.sendPresence('leave') } catch {} ; try { active.node?.stop() } catch {} } })

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
