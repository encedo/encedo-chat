/**
 * app.ts — Encedo Chat web GUI. Login (HEM) + main chat window.
 *
 * Identity in the HEM (hem-sdk-js). Rendezvous/messages via the SAME engine as
 * the CLI (../../lib, WebCrypto). Browser libp2p peer dials the onchato relay.
 * Message crypto is INTERIM (see lib/msgcrypto.ts) — EH-2 replaces it.
 */

import { HEM } from '../../../hem-sdk-js/hem-sdk.js'
import { topicFromSecret, announceMacKey, todayUTC } from '../../lib/rendezvous.ts'
import { interimSession } from '../../lib/session.ts'
import { joinChat } from '../../lib/room.ts'
import { createPeer, dial } from '../../net/peer.ts'
import { nowMs, utcHHMM } from '../../lib/time.ts'

// onchato relay — deterministic PeerId from --pass "bs1.onchato.com" (see net/onchato.ts)
const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'

const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'
let session: { hem: any; kid: string; handle: string; pub: string } | null = null

const setMsg = (id: string, text: string, kind: 'err' | 'ok') => { const m = $(id); m.textContent = text; m.className = 'msg ' + kind }
const clr = (id: string) => { const m = $(id); m.textContent = ''; m.className = 'msg' }

// ---- HEM reachability (no auth) ----
async function refreshStatus() {
  const url = val('hsm'); const dot = $('status-dot'); const hint = $('status-hint')
  dot.className = 'dot'; hint.textContent = ''
  if (!url) return
  try {
    const v: any = await new HEM(url).getVersion()
    dot.className = 'dot ok'; hint.textContent = `HEM ok — fw ${v?.fwv ?? '?'}`
  } catch {
    dot.className = 'dot bad'; hint.textContent = 'HEM nieosiągalny (adres / CORS)'
  }
}
$('hsm').addEventListener('blur', refreshStatus)

// ---- toggle login / register ----
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'
  const reg = mode === 'register'
  $('reg-handle-wrap').style.display = reg ? 'block' : 'none'
  ;($('go') as HTMLButtonElement).textContent = reg ? 'Zarejestruj' : 'Zaloguj'
  $('toggle-pre').textContent = reg ? 'Masz już konto?' : 'Nie masz konta?'
  $('toggle').textContent = reg ? 'Zaloguj' : 'Zarejestruj tożsamość'
  clr('msg')
})

// ---- login / register ----
$('go').addEventListener('click', async () => {
  const url = val('hsm'), pass = val('pass')
  if (!url || !pass) { setMsg('msg', 'Podaj adres HEM i hasło.', 'err'); return }
  const btn = $('go') as HTMLButtonElement
  btn.disabled = true; btn.textContent = '…'; clr('msg')
  try {
    const hem = new HEM(url)
    await hem.hemCheckin()
    if (mode === 'register') {
      const handle = val('handle')
      if (!handle) { setMsg('msg', 'Podaj handle.', 'err'); return }
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
      const key = keys[0]
      const handle = parseHandle(key.description)
      const use = await hem.authorizePassword(null, `keymgmt:use:${key.kid}`)
      const { pubkey } = await hem.getPubKey(use, key.kid)
      await enterApp(hem, handle, key.kid, pubkey)
    }
  } catch (e: any) {
    setMsg('msg', 'Błąd: ' + (e?.message ?? e), 'err')
  } finally {
    btn.disabled = false; btn.textContent = mode === 'register' ? 'Zarejestruj' : 'Zaloguj'
  }
})

function parseHandle(descr: Uint8Array | null): string {
  if (!descr) return '(?)'
  return dec.decode(descr).split('\0')[0].split(',')[1] ?? '(?)'
}
async function fingerprint(pubB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0))
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

async function enterApp(hem: any, handle: string, kid: string, pub: string) {
  session = { hem, kid, handle, pub }
  $('login').style.display = 'none'
  $('main').style.display = 'block'
  $('me-handle').textContent = handle
  $('me-fp').textContent = await fingerprint(pub)
  renderContacts()
}

// ---- contacts (localStorage, per identity) ----
type Contact = { name: string; pub: string }
const contactsKey = () => 'ec-contacts-' + (session?.handle ?? '_')
function loadContacts(): Contact[] { try { return JSON.parse(localStorage.getItem(contactsKey()) || '[]') } catch { return [] } }
function saveContacts(list: Contact[]) { localStorage.setItem(contactsKey(), JSON.stringify(list)) }
function upsertContact(name: string, pub: string) {
  const list = loadContacts().filter((c) => c.name !== name)
  list.push({ name, pub }); saveContacts(list); renderContacts()
}
function renderContacts() {
  const box = $('contacts'); box.innerHTML = ''
  const list = loadContacts()
  if (!list.length) { const e = document.createElement('span'); e.className = 'contact empty'; e.textContent = '(brak — dodaj poniżej)'; box.appendChild(e); return }
  for (const c of list) {
    const el = document.createElement('span'); el.className = 'contact'; el.textContent = c.name; el.title = c.pub
    el.addEventListener('click', () => { ($('peer-name') as HTMLInputElement).value = c.name; ($('peer-pub') as HTMLInputElement).value = c.pub })
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'
    x.addEventListener('click', (e) => { e.stopPropagation(); saveContacts(loadContacts().filter((k) => k.name !== c.name)); renderContacts() })
    el.appendChild(x); box.appendChild(el)
  }
}
$('save-contact').addEventListener('click', () => {
  const name = val('peer-name'), pub = val('peer-pub')
  if (!name || !pub) { setMsg('join-msg', 'Podaj nazwę i klucz, aby zapisać.', 'err'); return }
  upsertContact(name, pub); setMsg('join-msg', `Zapisano kontakt „${name}”.`, 'ok')
})
// Enter to submit on the login card
$('pass').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') ($('go') as HTMLButtonElement).click() })

// ---- join room + chat ----
function appendMsg(kind: 'me' | 'peer' | 'sys', text: string, ts?: number) {
  const box = $('messages')
  const d = document.createElement('div')
  d.className = 'm ' + kind
  if (ts !== undefined && kind !== 'sys') {
    const t = document.createElement('span')
    t.textContent = utcHHMM(ts) + ' '            // UTC always
    t.style.opacity = '0.5'; t.style.fontVariantNumeric = 'tabular-nums'
    d.appendChild(t); d.appendChild(document.createTextNode(text))
  } else {
    d.textContent = text
  }
  box.appendChild(d)
  box.scrollTop = box.scrollHeight
}

$('join').addEventListener('click', async () => {
  if (!session) return
  const peerName = val('peer-name'), peerPub = val('peer-pub')
  if (!peerName || !peerPub) { setMsg('join-msg', 'Podaj nazwę i klucz rozmówcy.', 'err'); return }
  const btn = $('join') as HTMLButtonElement
  btn.disabled = true; btn.textContent = 'łączę…'; clr('join-msg')
  try {
    const useTok = await session.hem.authorizePassword(null, `keymgmt:use:${session.kid}`)
    const ss: Uint8Array = await session.hem.ecdh(useTok, session.kid, peerPub)
    const p = { networkId: 'main', dateUTC: todayUTC() }
    const topic = await topicFromSecret(ss, p)
    const keys = { macKey: await announceMacKey(ss, p), session: await interimSession(ss, p) }

    const node = await createPeer()
    await dial(node, RELAY)

    upsertContact(peerName, peerPub)
    $('join-form').style.display = 'none'
    $('chat').style.display = 'block'
    $('peer-title').textContent = peerName
    appendMsg('sys', `Pokój otwarty (${topic.slice(0, 10)}…) — czekam na ${peerName}…`)

    let typingEl: HTMLElement | null = null
    const setPeerTyping = (on: boolean) => {
      if (on && !typingEl) {
        typingEl = document.createElement('div'); typingEl.className = 'm sys'; typingEl.textContent = `${peerName} pisze…`
        const box = $('messages'); box.appendChild(typingEl); box.scrollTop = box.scrollHeight
      } else if (!on && typingEl) { typingEl.remove(); typingEl = null }
    }

    const room = joinChat(node, topic, keys, {
      onMessage: (_from, m) => { setPeerTyping(false); appendMsg('peer', m.body, m.ts) },
      onTyping: (_from, state) => setPeerTyping(state === 'start'),
      onReaction: (_from, r) => appendMsg('sys', `${peerName}: ${r.emoji}`),
      onFile: (_from, f) => appendMsg('sys', `${peerName} udostępnił plik: ${f.name} — interim (IPFS TODO)`),
      onPresence: (_peer, ev) => {
        const label = ev === 'join' ? 'jest w pokoju' : ev === 'active' ? 'wrócił/a' : ev === 'away' ? 'jest nieobecny/a' : 'wyszedł/wyszła'
        appendMsg('sys', `${peerName} ${label}`)
        $('peer-dot').className = 'dot ' + (ev === 'join' || ev === 'active' ? 'ok' : ev === 'away' ? 'warn' : '')
        if (ev === 'leave') setPeerTyping(false)
      },
    })

    // local activity → typing / away meta
    let typingSent = false, away = false, typingTimer: any, awayTimer: any
    const stopTyping = () => { clearTimeout(typingTimer); if (typingSent) { typingSent = false; room.sendTyping('stop') } }
    const armAway = () => { clearTimeout(awayTimer); awayTimer = setTimeout(() => { away = true; stopTyping(); room.sendPresence('away') }, 60_000) }
    const activity = () => {
      if (away) { away = false; room.sendPresence('active') }
      if (!typingSent) { typingSent = true; room.sendTyping('start') }
      clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 4_000)
      armAway()
    }

    const send = () => {
      const inp = $('msg-input') as HTMLInputElement
      const t = inp.value.trim()
      if (!t) return
      room.sendText(t); appendMsg('me', t, nowMs()); inp.value = ''; stopTyping()
    }
    $('send').addEventListener('click', send)
    $('msg-input').addEventListener('input', activity)
    $('msg-input').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') send() })
    document.addEventListener('visibilitychange', () => { if (document.hidden) { away = true; stopTyping(); room.sendPresence('away') } })
    window.addEventListener('beforeunload', () => { try { room.sendPresence('leave') } catch {} ; try { (node as any).stop() } catch {} })
  } catch (e: any) {
    setMsg('join-msg', 'Błąd: ' + (e?.message ?? e), 'err')
    btn.disabled = false; btn.textContent = 'Wejdź do pokoju'
  }
})

$('logout').addEventListener('click', () => location.reload())
