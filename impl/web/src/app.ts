/**
 * app.ts — Encedo Chat web GUI (login window). Slice 2: HEM connect + status +
 * register/login → identity established in the browser. Chat window is Slice 3.
 *
 * Identity lives in the HEM (via hem-sdk-js). Crypto is WebCrypto (engine in
 * ../../lib). No node:crypto, no crypto lib.
 */

import { HEM } from '../../../hem-sdk-js/hem-sdk.js'

const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'

function showMsg(text: string, kind: 'err' | 'ok') { const m = $('msg'); m.textContent = text; m.className = 'msg ' + kind }
function clearMsg() { const m = $('msg'); m.textContent = ''; m.className = 'msg' }

// ---- HEM reachability (no auth) → green/red dot ----
async function refreshStatus() {
  const url = val('hsm'); const dot = $('status-dot'); const hint = $('status-hint')
  dot.className = 'dot'; hint.textContent = ''
  if (!url) return
  try {
    const v: any = await new HEM(url).getVersion()
    dot.className = 'dot ok'
    hint.textContent = `HEM ok — fw ${v?.fwv ?? '?'}`
  } catch {
    dot.className = 'dot bad'
    hint.textContent = 'HEM nieosiągalny (adres / CORS)'
  }
}
$('hsm').addEventListener('blur', refreshStatus)

// ---- toggle login / register (nodes kept, only text changes) ----
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'
  const reg = mode === 'register'
  $('reg-handle-wrap').style.display = reg ? 'block' : 'none'
  ;($('go') as HTMLButtonElement).textContent = reg ? 'Zarejestruj' : 'Zaloguj'
  $('toggle-pre').textContent = reg ? 'Masz już konto?' : 'Nie masz konta?'
  $('toggle').textContent = reg ? 'Zaloguj' : 'Zarejestruj tożsamość'
  clearMsg()
})

// ---- login / register ----
$('go').addEventListener('click', async () => {
  const url = val('hsm'), pass = val('pass')
  if (!url || !pass) { showMsg('Podaj adres HEM i hasło.', 'err'); return }
  const btn = $('go') as HTMLButtonElement
  btn.disabled = true; btn.textContent = '…'; clearMsg()
  try {
    const hem = new HEM(url)
    await hem.hemCheckin()
    if (mode === 'register') {
      const handle = val('handle')
      if (!handle) { showMsg('Podaj handle.', 'err'); return }
      const gen = await hem.authorizePassword(pass, 'keymgmt:gen')
      const iat = Math.floor(Date.now() / 1000)
      const descr = btoa(`ETSEIC:self,${handle},ik,${iat}`)
      const { kid } = await hem.createKeyPair(gen, `chat-ik-${handle}`, 'CURVE25519', descr)
      const use = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
      const { pubkey } = await hem.getPubKey(use, kid)
      await showMain(handle, kid, pubkey)
    } else {
      const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:self,')
      if (!keys.length) { showMsg('Brak tożsamości czatu na tym HEM — zarejestruj.', 'err'); return }
      const key = keys[0]
      const handle = parseHandle(key.description)
      const use = await hem.authorizePassword(null, `keymgmt:use:${key.kid}`)
      const { pubkey } = await hem.getPubKey(use, key.kid)
      await showMain(handle, key.kid, pubkey)
    }
  } catch (e: any) {
    showMsg('Błąd: ' + (e?.message ?? e), 'err')
  } finally {
    btn.disabled = false
    btn.textContent = mode === 'register' ? 'Zarejestruj' : 'Zaloguj'
  }
})

function parseHandle(descr: Uint8Array | null): string {
  if (!descr) return '(?)'
  const s = dec.decode(descr).split('\0')[0]   // ETSEIC:self,<handle>,ik,<iat>
  return s.split(',')[1] ?? '(?)'
}

async function fingerprint(pubB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0))
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

async function showMain(handle: string, kid: string, pubB64: string) {
  $('login').style.display = 'none'
  $('main').style.display = 'block'
  $('me-handle').innerHTML = `<b>${handle}</b>`
  $('me-kid').innerHTML = `kid: <b>${kid}</b>`
  $('me-fp').innerHTML = `fingerprint: <b>${await fingerprint(pubB64)}</b>`
  ;(window as any).__me = { handle, kid, pub: pubB64 }   // for the chat window (Slice 3)
}

$('logout').addEventListener('click', () => location.reload())
