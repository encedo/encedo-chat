/**
 * browser-test.ts — drive the REAL web app in two headless browsers.
 *
 *   node net/browser-test.ts                        # Chromium ×2
 *   BROWSERS=chromium,firefox node net/browser-test.ts
 *   APP_URL=http://localhost:3000/?eh2=1 node net/browser-test.ts
 *
 * Everything else we run is Node, and Node has no RTCPeerConnection — so the
 * WebRTC data plane, the one that actually carries content in a browser once
 * two peers meet, was covered by nothing but manual clicking. This closes that:
 * two browsers with separate profiles (separate identities), the deployed
 * bundle, the real relay, and the app driven through its own DOM.
 *
 * **Two protocols, because the browsers do not agree on one.** Chromium speaks
 * CDP; Firefox removed CDP in 129 and speaks **WebDriver BiDi**. Both are just
 * JSON over a WebSocket, so both drivers live here behind one `Page` interface
 * and no dependency is needed — Node 24 has WebSocket built in, and both
 * browsers are already on the machine.
 *
 * The mixed pair is the point: Chromium↔Chromium says nothing about ICE between
 * two different implementations, and a real session between them is exactly
 * where "connected, but over the relay" was first noticed.
 *
 * It asserts the things a user would notice: the EH-2 badge turning green on
 * BOTH sides, messages arriving each way, the delivery mark appearing (so the
 * ack path is exercised in a browser too), and the transport badge flipping to
 * WebRTC Direct. On failure it prints each browser's own console trace — the
 * `[ec …]` narration — which is usually enough to see where it stopped.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir, homedir } from 'node:os'
import { join, extname } from 'node:path'

/**
 * By default this serves `web/dist` from THIS checkout, so it tests the code in
 * the repo rather than whatever happens to be deployed. (Which matters: the
 * first run of this file failed on a missing delivery mark, and the cause was
 * simply that production predated the feature.) Point APP_URL at onchato.com to
 * check a deployment instead. The relay is the real one either way.
 */
const DIST = join(import.meta.dirname, '..', 'web', 'dist')
const LOCAL_PORT = 9333
const APP_URL = process.env.APP_URL ?? `http://127.0.0.1:${LOCAL_PORT}/?eh2=1&debug=1`
const SERVE_LOCAL = !process.env.APP_URL

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
function serveDist(): Server {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(`no build at ${DIST} — run: npm run web:build`)
    process.exit(2)
  }
  const srv = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  })
  srv.listen(LOCAL_PORT, '127.0.0.1')
  return srv
}
const CHROME = process.env.CHROME ?? '/usr/bin/chromium-browser'
const FIREFOX = process.env.FIREFOX ?? '/usr/bin/firefox'
const HEADFUL = process.env.HEADFUL === '1'
// Debug fast-path: GROUP_ONLY=1 runs setup (login + EH-2) then jumps straight to
// the group scenario, skipping the middle scenarios — cheaper to iterate on.
const GROUP_ONLY = process.env.GROUP_ONLY === '1'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * What a scenario needs from a browser, whichever protocol it speaks. Anything
 * one browser can do and the other cannot (freezing a tab) is optional here and
 * degrades to nothing rather than failing the run.
 */
abstract class Page {
  readonly console: string[] = []
  name: string
  constructor(name: string) { this.name = name }

  abstract start(url: string): Promise<void>
  abstract eval<T = any>(expression: string): Promise<T>
  abstract resize(width: number, height: number): Promise<void>
  abstract reload(url: string): Promise<void>
  abstract stop(): Promise<void>
  /** Put the tab into the frozen lifecycle state. CDP only; a no-op elsewhere. */
  async freeze(_frozen: boolean): Promise<void> {}
  /**
   * Cut this browser off the network. Returns false where the protocol cannot do
   * it (BiDi has no equivalent), so the caller can skip the scenario out loud
   * instead of asserting against something that never happened.
   */
  async offline(_cut: boolean): Promise<boolean> { return false }

  async waitFor<T>(what: string, expression: string, ms = 30_000): Promise<T> {
    const t0 = Date.now()
    for (;;) {
      const v = await this.eval<T>(expression)
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: timed out waiting for ${what}`)
      await sleep(250)
    }
  }
}

/** A Chromium instance plus the CDP session for its one page. */
class Browser extends Page {
  proc!: ChildProcess
  ws!: WebSocket
  sessionId!: string
  dir!: string
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

  // no parameter properties: Node runs this .ts in strip-only mode
  constructor(name: string) { super(name) }

  async start(url: string): Promise<void> {
    this.dir = mkdtempSync(join(tmpdir(), `ec-${this.name}-`))
    this.proc = spawn(CHROME, [
      HEADFUL ? '--headless=false' : '--headless=new',
      // Let Chromium pick the port (see discover() for how we learn it): a
      // fixed one silently attaches us to a LEFTOVER browser from an earlier run.
      '--remote-debugging-port=0',
      `--user-data-dir=${this.dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    const target = await this.discover()
    this.ws = new WebSocket(target.browserWs)
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', () => rej(new Error(`${this.name}: CDP socket failed`)), { once: true })
    })
    this.ws.addEventListener('message', (ev: any) => this.onMessage(String(ev.data)))

    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find((t: any) => t.type === 'page')
    if (!page) throw new Error(`${this.name}: no page target`)
    const att = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    this.sessionId = att.sessionId
    await this.send('Runtime.enable', {}, true)
    await this.send('Page.enable', {}, true)
  }

  /**
   * Chromium announces its endpoint on stderr ("DevTools listening on ws://…").
   * Read it from there rather than from DevToolsActivePort in the profile dir:
   * a snap-confined Chromium does not write that file where we asked it to,
   * and a fixed port would happily attach us to a LEFTOVER browser from an
   * earlier run — which cost one confusing failure here (stale profile, stale
   * state, a "bug" that was only the previous test still alive).
   */
  private async discover(): Promise<{ browserWs: string }> {
    return new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`${this.name}: Chromium never announced a CDP endpoint`)), 25_000)
      this.proc.stderr?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) { clearTimeout(timer); resolve({ browserWs: m[1] }) }
      })
      this.proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${this.name}: Chromium exited (${code})`)) })
    })
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw)
    if (msg.id && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!
      this.waiting.delete(msg.id)
      msg.error ? w.reject(new Error(`${this.name}: ${msg.error.message}`)) : w.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const isCss = (v: any) => typeof v === 'string' && /^(color|font|background)\s*:/.test(v)
      const text = (msg.params.args ?? [])
        .map((a: any) => a.value ?? a.description ?? '')
        .filter((v: any) => !isCss(v))
        .join(' ')
      if (text.trim()) this.console.push(text.replace(/%c/g, '').trim())
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.console.push(`EXCEPTION: ${msg.params.exceptionDetails?.exception?.description ?? '?'}`)
    }
  }

  /** Send a command we do not expect an answer to (the browser dies mid-reply). */
  private fire(method: string, params: any = {}) {
    try { this.ws?.send(JSON.stringify({ id: this.next++, method, params })) } catch {}
  }

  send(method: string, params: any = {}, session = false): Promise<any> {
    const id = this.next++
    const payload: any = { id, method, params }
    if (session && this.sessionId) payload.sessionId = this.sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${this.name}: ${method} timed out`)) }, 30_000)
    })
  }

  /** Evaluate in the page and return the JSON value. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    }, true)
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description ?? 'eval failed'}`)
    return r.result?.value
  }

  /** Freeze/thaw the tab (best effort: not every build allows it). */
  async freeze(frozen: boolean) {
    try { await this.send('Page.setWebLifecycleState', { state: frozen ? 'frozen' : 'active' }, true) } catch {}
  }

  /** Pull the network out from under the page — closes its relay socket for real. */
  async offline(cut: boolean): Promise<boolean> {
    try {
      await this.send('Network.enable', {}, true)
      await this.send('Network.emulateNetworkConditions', {
        offline: cut, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }, true)
      return true
    } catch { return false }
  }

  /** Resize the viewport — layout rules that only apply at some widths need it. */
  async resize(width: number, height: number) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, true)
    await sleep(200)
  }

  async reload(url: string) {
    await this.send('Page.navigate', { url }, true)
    await sleep(1200)
  }

  async stop() {
    // ASK the browser to quit before signalling it. `proc.kill()` cannot be
    // relied on: a snap-confined Chromium refuses signals from a confined
    // parent with EPERM, and the old `try { … } catch {}` turned that refusal
    // into silence — every run leaked a whole browser tree (two browsers, their
    // zygotes and renderers, well over half a gigabyte) that outlived the
    // harness, until enough runs had accumulated to take the machine down.
    // `Browser.close` travels the socket we have been driving all along, so it
    // needs no permission at all; the signal stays as the fallback, and if that
    // is refused too we SAY so instead of leaving it to be discovered in `free`.
    this.fire('Browser.close')
    const quit = await this.exited(3_000)
    // Close the CDP socket after: an open WebSocket keeps Node's event loop
    // alive, so without this the run printed PASS and then hung forever —
    // which in CI is a green result inside a timed-out job.
    try { this.ws?.close() } catch {}
    if (!quit) {
      try { this.proc.kill('SIGKILL') } catch (e: any) {
        console.log(`⚠ ${this.name}: cannot signal Chromium (${e?.code ?? e})`)
      }
      if (!(await this.exited(2_000))) {
        console.log(`⚠ ${this.name}: Chromium (pid ${this.proc.pid}) is STILL RUNNING — kill it by hand,`
          + ' leaked browsers from repeated runs are what exhausts this machine')
      }
    }
    try { rmSync(this.dir, { recursive: true, force: true }) } catch {}
  }

  /** True once the process is gone; false if it is still there after `ms`. */
  private exited(ms: number): Promise<boolean> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve(true)
    return new Promise((res) => {
      const t = setTimeout(() => res(false), ms)
      this.proc.once('exit', () => { clearTimeout(t); res(true) })
    })
  }
}

/**
 * A Firefox instance driven over **WebDriver BiDi** — Firefox has spoken no CDP
 * since 129, and BiDi is what replaced it. Same shape as the CDP driver: spawn,
 * read the endpoint the browser prints on stderr, then JSON over a WebSocket.
 *
 * Two things about it are not obvious and both cost a debugging round:
 *
 *  - **The profile must live somewhere the snap can see.** Ubuntu's Firefox is a
 *    snap, and snap confinement hides dot-directories in $HOME, so a profile
 *    under `~/.cache/…` is silently unusable — Firefox falls back to the user's
 *    real profile, hits its lock, and prints "Firefox is already running".
 *    `~/snap/firefox/common` is inside the sandbox and works.
 *  - **BiDi returns structured values, not JSON.** `script.evaluate` answers with
 *    a RemoteValue tree ({type:'number', value:…}, objects as entry lists), so
 *    everything has to be turned back into plain data — see `plain()`.
 */
class Firefox extends Page {
  proc!: ChildProcess
  ws!: WebSocket
  dir!: string
  private context!: string
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

  constructor(name: string) { super(name) }

  async start(url: string): Promise<void> {
    const snapCommon = join(homedir(), 'snap', 'firefox', 'common')
    const base = existsSync(snapCommon) ? snapCommon : tmpdir()
    this.dir = mkdtempSync(join(base, `ec-${this.name}-`))
    this.proc = spawn(FIREFOX, [
      ...(HEADFUL ? [] : ['--headless']),
      '--new-instance',
      '--profile', this.dir,
      '--remote-debugging-port', '0', // let it choose; we read the port it announces
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    const endpoint = await this.discover()
    this.ws = new WebSocket(endpoint)
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', () => rej(new Error(`${this.name}: BiDi socket failed`)), { once: true })
    })
    this.ws.addEventListener('message', (ev: any) => this.onMessage(String(ev.data)))

    await this.send('session.new', { capabilities: {} })
    await this.send('session.subscribe', { events: ['log.entryAdded'] })
    // The context exists as soon as the window does, but "as soon as" is not
    // instant on a cold profile.
    for (let i = 0; ; i++) {
      const tree = await this.send('browsingContext.getTree', {})
      const ctx = tree.contexts?.[0]?.context
      if (ctx) { this.context = ctx; break }
      if (i > 40) throw new Error(`${this.name}: Firefox never opened a browsing context`)
      await sleep(250)
    }
  }

  /** Firefox prints `WebDriver BiDi listening on ws://…` on stderr. */
  private async discover(): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`${this.name}: Firefox never announced a BiDi endpoint`)), 40_000)
      this.proc.stderr?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)
        if (m) { clearTimeout(timer); resolve(`${m[1]}/session`) }
      })
      this.proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${this.name}: Firefox exited (${code})`)) })
    })
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw)
    if (msg.id && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!
      this.waiting.delete(msg.id)
      msg.type === 'error' ? w.reject(new Error(`${this.name}: ${msg.error} ${msg.message ?? ''}`)) : w.resolve(msg.result)
      return
    }
    if (msg.type === 'event' && msg.method === 'log.entryAdded') {
      const isCss = (v: any) => typeof v === 'string' && /^(color|font|background)\s*:/.test(v)
      const args = (msg.params.args ?? []).map((a: any) => plain(a)).filter((v: any) => !isCss(v))
      const text = args.length ? args.join(' ') : (msg.params.text ?? '')
      if (String(text).trim()) this.console.push(String(text).replace(/%c/g, '').trim())
    }
  }

  send(method: string, params: any = {}): Promise<any> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${this.name}: ${method} timed out`)) }, 30_000)
    })
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('script.evaluate', {
      expression: `(() => { ${expression} })()`,
      target: { context: this.context },
      awaitPromise: true,
      serializationOptions: { maxObjectDepth: 5, maxDomDepth: 0 },
    })
    if (r.type === 'exception') throw new Error(`${this.name}: ${r.exceptionDetails?.text ?? 'eval failed'}`)
    return plain(r.result) as T
  }

  async resize(width: number, height: number) {
    await this.send('browsingContext.setViewport', { context: this.context, viewport: { width, height } })
    await sleep(200)
  }

  async reload(url: string) {
    await this.send('browsingContext.navigate', { context: this.context, url, wait: 'complete' })
    await sleep(1200)
  }

  async stop() {
    // Same lesson as the CDP driver: ask over the socket we already hold, and
    // say so out loud if the process still refuses to go.
    try { this.ws?.send(JSON.stringify({ id: this.next++, method: 'browser.close', params: {} })) } catch {}
    const quit = await this.exited(4_000)
    try { this.ws?.close() } catch {}
    if (!quit) {
      try { this.proc.kill('SIGKILL') } catch (e: any) {
        console.log(`⚠ ${this.name}: cannot signal Firefox (${e?.code ?? e})`)
      }
      if (!(await this.exited(3_000))) {
        console.log(`⚠ ${this.name}: Firefox (pid ${this.proc.pid}) is STILL RUNNING — kill it by hand,`
          + ' leaked browsers from repeated runs are what exhausts this machine')
      }
    }
    try { rmSync(this.dir, { recursive: true, force: true }) } catch {}
  }

  private exited(ms: number): Promise<boolean> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve(true)
    return new Promise((res) => {
      const t = setTimeout(() => res(false), ms)
      this.proc.once('exit', () => { clearTimeout(t); res(true) })
    })
  }
}

/** BiDi RemoteValue → plain JS. Objects arrive as entry lists, arrays as lists. */
function plain(v: any): any {
  if (!v || typeof v !== 'object') return v
  switch (v.type) {
    case 'undefined': case 'null': return null
    case 'string': case 'number': case 'boolean': case 'bigint': return v.value
    case 'array': case 'set': return (v.value ?? []).map(plain)
    case 'object': case 'map': return Object.fromEntries((v.value ?? []).map(([k, val]: any[]) => [plain(k), plain(val)]))
    default: return v.value ?? null
  }
}

const step = (msg: string) => console.log(`• ${msg}`)
const scenario = (name: string) => console.log(`\n▸ ${name}`)

const BADGE_GREEN = `return document.getElementById('e2e-badge').textContent.includes('ratchet') ? document.getElementById('e2e-badge').textContent : ''`
const send = (b: Page, text: string) => b.eval(`
  const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(text)};
  document.getElementById('send').click(); return 1;
`)
const seen = (text: string) => `return document.getElementById('messages').textContent.includes(${JSON.stringify(text)})`

/**
 * Which two browsers to pair. `chromium,firefox` is the mixed run — the one that
 * says anything about ICE between different implementations.
 */
const PAIR = (process.env.BROWSERS ?? 'chromium,chromium').split(',').map((s) => s.trim().toLowerCase())
const makePage = (kind: string, name: string): Page => {
  if (kind === 'firefox') return new Firefox(name)
  if (kind === 'chromium' || kind === 'chrome') return new Browser(name)
  throw new Error(`unknown browser "${kind}" — use chromium or firefox`)
}

/** Log in with the software identity already in this profile's localStorage. */
async function login(b: Page, handle: string) {
  await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
  await b.eval(`(document.getElementById('handle')).value = ${JSON.stringify(handle)}; document.getElementById('go-soft').click();`)
  await b.waitFor('contact list', `return !!document.querySelector('#pane-contacts .contact')`)
}

/** Click a contact by its visible name. */
async function openContact(b: Page, name: string) {
  await b.eval(`
    const el = [...document.querySelectorAll('#pane-contacts .contact')]
      .find((c) => c.textContent.includes(${JSON.stringify(name)}));
    if (!el) throw new Error('no contact ' + ${JSON.stringify(name)});
    el.click(); return 1;
  `)
}

/** One message each way — the check that a conversation is genuinely alive. */
async function roundTrip(A: Page, B: Page, tag: string) {
  const a = `A-${tag}-${Date.now().toString(36)}`
  await send(A, a)
  await B.waitFor(`A→B (${tag})`, seen(a), 25_000)
  const b = `B-${tag}-${Date.now().toString(36)}`
  await send(B, b)
  await A.waitFor(`B→A (${tag})`, seen(b), 25_000)
}

async function main() {
  const A = makePage(PAIR[0], 'A')
  const B = makePage(PAIR[1] ?? PAIR[0], 'B')
  const server = SERVE_LOCAL ? serveDist() : null
  if (server) step(`serving this checkout's web/dist on 127.0.0.1:${LOCAL_PORT}`)
  try {
    scenario('setup — two browsers, two identities, one room')
    step(`launching ${PAIR[0]} + ${PAIR[1] ?? PAIR[0]} on ${APP_URL}`)
    await Promise.all([A.start(APP_URL), B.start(APP_URL)])

    for (const [b, handle] of [[A, 'sim-a'], [B, 'sim-b']] as const) {
      await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
      await b.eval(`(document.getElementById('handle')).value = ${JSON.stringify(handle)}; document.getElementById('go-soft').click();`)
      await b.waitFor('app shell', `return document.getElementById('app') && !document.getElementById('app').hidden`)
    }
    const pubA = await A.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id-sim-a')).pub`)
    const pubB = await B.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id-sim-b')).pub`)
    step(`identities ready — A ${pubA.slice(0, 12)}…  B ${pubB.slice(0, 12)}…`)

    // A also gets a second, unreachable contact — the "switch away and back" test
    // needs somewhere to switch TO.
    const ghostPub = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff)).toString('base64')
    await A.eval(`localStorage.setItem('ec-local-contacts-sim-a', ${JSON.stringify(JSON.stringify([{ name: 'sim-b', pub: pubB }, { name: 'ghost', pub: ghostPub }]))}); return 1`)
    await B.eval(`localStorage.setItem('ec-local-contacts-sim-b', ${JSON.stringify(JSON.stringify([{ name: 'sim-a', pub: pubA }]))}); return 1`)
    await Promise.all([A.reload(APP_URL), B.reload(APP_URL)])
    await Promise.all([login(A, 'sim-a'), login(B, 'sim-b')])

    await Promise.all([openContact(A, 'sim-b'), openContact(B, 'sim-a')])
    const [ba, bb] = await Promise.all([A.waitFor<string>('EH-2 on A', BADGE_GREEN, 45_000), B.waitFor<string>('EH-2 on B', BADGE_GREEN, 45_000)])
    step(`EH-2 established in both: "${ba.trim()}" / "${bb.trim()}"`)

    let direct = false
    if (!GROUP_ONLY) {
    scenario('messages both ways, with delivery confirmations')
    await roundTrip(A, B, 'first')
    await A.waitFor('delivery mark on A', `return document.getElementById('messages').textContent.includes('dostarczone')`, 20_000)
    await B.waitFor('delivery mark on B', `return document.getElementById('messages').textContent.includes('dostarczone')`, 20_000)
    step('both sides show ✓ dostarczone (ack path works in a browser)')

    scenario('transport upgrade to a direct DataChannel')
    direct = (await A.eval<string>(`return document.getElementById('transport-badge').textContent`)).includes('Direct')
    if (!direct) {
      try {
        await A.waitFor('WebRTC direct', `return document.getElementById('transport-badge').textContent.includes('Direct')`, 25_000)
        direct = true
      } catch { /* reported at the end */ }
    }
    step(direct ? 'transport upgraded to WebRTC Direct' : '⚠ still on relay — WebRTC did not come up')
    await roundTrip(A, B, 'after-upgrade')
    step('messages still flow after the transport decision')

    // ---- the scenarios that come from real manual testing --------------------

    scenario('one side reloads mid-conversation')
    // A page reload means a NEW ephemeral PeerId and a fresh room, while the
    // peer still holds a ratchet for the old one. The reloading side must be
    // able to re-handshake, and the other side must accept it.
    await A.reload(APP_URL)
    await login(A, 'sim-a')
    await openContact(A, 'sim-b')
    await A.waitFor('EH-2 after reload (A)', BADGE_GREEN, 45_000)
    await B.waitFor('EH-2 after reload (B)', BADGE_GREEN, 45_000)
    await roundTrip(A, B, 'after-reload')
    step('conversation re-established and messages flow again')

    scenario('a tab goes to the background and comes back')
    // Browsers throttle timers in a hidden tab, so the Announce heartbeat goes
    // quiet and the peer eventually stops seeing us. What must NOT happen is
    // losing the session: coming back has to resume, not break.
    const hide = (b: Page, hidden: boolean) => b.eval(`
      Object.defineProperty(document, 'hidden', { value: ${hidden}, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: ${hidden ? "'hidden'" : "'visible'"}, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return 1;
    `)
    await hide(B, true)
    await B.freeze(true) // CDP only; on Firefox the visibility override alone has to do
    await sleep(12_000)
    await B.freeze(false)
    await hide(B, false)
    await roundTrip(A, B, 'after-background')
    step('messages flow after 12 s in the background')

    scenario('the relay connection dies and comes back on its own')
    // The failure this comes from: a laptop that slept, or a network blip, left
    // the room looking healthy — green badge, peer "present" for another 90 s —
    // while nothing could leave the tab. Recovery waited for the user to focus
    // the tab. What must happen instead: the client notices by itself, says so,
    // re-dials, and the backlog arrives IN ORDER once it is back.
    if (await B.offline(true)) {
      const sawIt = await B.eval<boolean>('return navigator.onLine === false')
      step(`network cut — the page ${sawIt ? 'knows it is offline' : 'still believes it is online'}`)
      await B.waitFor('B admits it is not connected',
        `return /wznawiam|brak połączenia/.test(document.getElementById('peer-status').textContent)`, 30_000)
      step('B noticed the relay was gone without being touched — no tab focus, no user action')

      // CDP's offline emulation kills sockets, but NOT WebRTC — its traffic does
      // not go through the emulated stack. That is worth asserting rather than
      // working around: with the direct plane up, losing the relay must not stop
      // the conversation. It is the whole point of §13.
      const direktMsg = `bez-przekaźnika-${Date.now().toString(36)}`
      await send(A, direktMsg)
      let survived = true
      try { await B.waitFor('content over the direct channel', seen(direktMsg), 15_000) } catch { survived = false }
      step(survived
        ? 'the relay is gone and messages still flow — content is genuinely P2P'
        : '⚠ content stopped with the relay (was the direct channel up?)')

      await B.offline(false)
      await B.waitFor('B is back on its feet',
        `return !/wznawiam|brak połączenia/.test(document.getElementById('peer-status').textContent)`, 40_000)
      await roundTrip(A, B, 'after-outage')
      step('re-dialled by itself and the conversation resumed')
      // The ordered backlog after an outage is pinned at the room level instead
      // (test/room-eh2.test.ts) — reproducing a relay-only outage in a browser
      // would mean tearing down a working DataChannel to prove a point.
    } else {
      step('⚠ skipped — this driver cannot cut the network (BiDi has no equivalent)')
    }

    scenario('switching to another contact and back')
    await openContact(A, 'ghost')          // a peer that will never answer
    await sleep(2_000)
    await openContact(A, 'sim-b')          // …and back to the real conversation
    await A.waitFor('EH-2 after switching back', BADGE_GREEN, 45_000)
    await roundTrip(A, B, 'after-switch')
    step('the original conversation resumed after switching away')

    scenario('an incoming message opens in the background, not in your face')
    // The point of the model: while you read one conversation, a message from
    // ANOTHER contact must light an unread dot on the list — never yank the view
    // (5 people writing must not thrash your windows). A opens `sim-b`'s room in
    // the background to RECEIVE, but stays looking at `ghost`.
    await openContact(A, 'ghost')          // look away at a peer that never answers
    await sleep(500)
    const away = await A.eval<string>(`return document.getElementById('peer-name').textContent`)
    const bgTok = `w-tle-${Date.now().toString(36)}`
    await send(B, bgTok)                    // B writes while A is looking at ghost
    await A.waitFor('unread pill on sim-b', `
      const c = [...document.querySelectorAll('#pane-contacts .contact')].find((x) => x.textContent.includes('sim-b'));
      return !!(c && c.querySelector('.c-unread'));
    `, 25_000)
    const stillAway = await A.eval<string>(`return document.getElementById('peer-name').textContent`)
    const leaked = await A.eval<boolean>(`return document.getElementById('messages').textContent.includes(${JSON.stringify(bgTok)})`)
    if (stillAway !== away) throw new Error(`view was yanked to another conversation (${away} → ${stillAway})`)
    if (leaked) throw new Error('a background message rendered into the foreground transcript')
    step('message landed in the background — unread dot lit, view unmoved')
    await openContact(A, 'sim-b')           // now go read it
    await A.waitFor('the buffered message shows on switch', seen(bgTok), 10_000)
    const pillGone = await A.eval<boolean>(`
      const c = [...document.querySelectorAll('#pane-contacts .contact')].find((x) => x.textContent.includes('sim-b'));
      return !(c && c.querySelector('.c-unread'));
    `)
    if (!pillGone) throw new Error('unread pill did not clear after opening the conversation')
    step('opening the conversation replayed the buffered message and cleared the dot')

    scenario('returning to a mobile room does not tear it down')
    // Reported from a split-screen phone: tapping the back-arrow to the peer
    // list and then back into the room rebuilt the whole conversation — a
    // presence:leave, a stopped ratchet, a fresh handshake, and one side
    // flipping to Relay while the other stayed on WebRTC — so messages stopped
    // until the ratchet came back N seconds later. Returning to a room that is
    // ALREADY open must just show it.
    await B.resize(390, 780) // phone width → mobile one-pane layout
    await B.waitFor('the back arrow', `return document.getElementById('btn-back').getBoundingClientRect().height > 0`, 8_000)
    const peerIdBefore = await B.eval<string>(`return document.getElementById('sess-peerid').textContent`)
    await B.eval(`document.getElementById('btn-back').click(); return 1`)   // to the peer list
    await sleep(1_000)
    await openContact(B, 'sim-a')                                          // tap the contact → back to the room
    await sleep(1_500)
    const peerIdAfter = await B.eval<string>(`return document.getElementById('sess-peerid').textContent`)
    if (peerIdBefore !== peerIdAfter) throw new Error(`returning rebuilt the session (peerId ${peerIdBefore} → ${peerIdAfter})`)
    if (!(await B.eval(BADGE_GREEN))) throw new Error('EH-2 badge dropped on return — the room was torn down')
    const t0 = Date.now()
    await roundTrip(A, B, 'after-return')
    if (Date.now() - t0 > 8_000) throw new Error(`round-trip after return took ${Date.now() - t0} ms — looks like a rebuild`)
    step('same session, same badge, messages flow at once')
    await B.resize(1200, 800)

    scenario('the unread counter keeps working after you leave and come back')
    // Reported on Android: the counter fired ONCE. The mobile back-arrow leaves
    // the room `activePub` but hides its pane, so a new message rendered into the
    // hidden pane instead of lighting the dot. Back on the peer list, a message
    // from the peer must re-light the unread pill.
    await B.resize(390, 780)
    await B.waitFor('back arrow', `return document.getElementById('btn-back').getBoundingClientRect().height > 0`, 8_000)
    await B.eval(`document.getElementById('btn-back').click(); return 1`) // to the peer list
    await sleep(500)
    const probe = `unread-again-${Date.now().toString(36)}`
    await send(A, probe)
    await B.waitFor('the unread pill re-lights on sim-a', `
      const c = [...document.querySelectorAll('#pane-contacts .contact')].find((x) => x.textContent.includes('sim-a'));
      return !!(c && c.querySelector('.c-unread'));
    `, 20_000)
    step('a message after leaving re-lit the unread dot')
    await openContact(B, 'sim-a')
    await B.waitFor('the message shows on open', seen(probe), 10_000)
    const cleared = await B.eval<boolean>(`
      const c = [...document.querySelectorAll('#pane-contacts .contact')].find((x) => x.textContent.includes('sim-a'));
      return !(c && c.querySelector('.c-unread'));
    `)
    if (!cleared) throw new Error('unread pill did not clear on return')
    step('opening it showed the message and cleared the pill')
    await B.resize(1200, 800)

    scenario('reading older messages is not interrupted by new ones')
    // Fill past one screen so the transcript can actually scroll, then read
    // from the top while the peer keeps talking.
    for (let i = 0; i < 15; i++) await send(A, `wypełniacz ${i}`)
    await B.waitFor('the filler arrived', seen('wypełniacz 14'), 40_000)
    // Both layouts, because the narrow one has its own rules and it is the one
    // that was broken: under 860px the chat panel grew with the transcript, so
    // the messages box never overflowed. Nothing scrolled inside it, the ⬇
    // button could never appear, and the whole page scrolled instead — two
    // browser windows side by side are enough to land in that layout.
    for (const [w, h, label] of [[780, 620, 'narrow'], [1200, 800, 'wide']] as const) {
      await B.resize(w, h)
      await B.eval(`
        const m = document.getElementById('messages');
        if (m.scrollHeight <= m.clientHeight) throw new Error(
          'transcript does not scroll at ${w}px — the page scrolls instead'
          + ' (messages ' + m.scrollHeight + '/' + m.clientHeight
          + ', chat panel ' + document.querySelector('.chat').clientHeight + 'px)');
        m.scrollTop = 0; m.dispatchEvent(new Event('scroll')); return 1;
      `)
      await B.waitFor(`the ⬇ button (${label})`, `return document.getElementById('to-bottom').hidden === false`, 10_000)
      const tail = `ogon-${label}-${Date.now().toString(36)}`
      await send(A, tail)
      await B.waitFor(`an unread count (${label})`, `return document.getElementById('unread').hidden === false`, 25_000)
      if (!(await B.eval<boolean>(`return document.getElementById('messages').scrollTop < 40`)))
        throw new Error(`the view scrolled away from the reader (${label})`)
      const beforeClick = await B.eval<any>(`
        const m = document.getElementById('messages');
        return { top: m.scrollTop, unreadHidden: document.getElementById('unread').hidden, unread: document.getElementById('unread').textContent };
      `)
      await B.eval(`document.getElementById('to-bottom').click(); return 1`)
      const afterClick = await B.eval<any>(`
        const m = document.getElementById('messages');
        return new Promise((r) => setTimeout(() => r({
          top: m.scrollTop, unreadHidden: document.getElementById('unread').hidden,
          unread: document.getElementById('unread').textContent,
          gap: m.scrollHeight - m.scrollTop - m.clientHeight,
          toBottomHidden: document.getElementById('to-bottom').hidden,
        }), 1200));
      `)
      console.log('   before:', JSON.stringify(beforeClick), 'after:', JSON.stringify(afterClick))
      await B.waitFor(`back at the newest message (${label})`, `
        const m = document.getElementById('messages');
        return m.scrollHeight - m.scrollTop - m.clientHeight < 80 && document.getElementById('to-bottom').hidden;
      `, 10_000)
      if (!(await B.eval<boolean>(seen(tail)))) throw new Error(`the newest message is missing (${label})`)
      step(`${label} layout: the view stays put, counts what arrived, and ⬇ returns to it`)
    }

    scenario('the phone layout')
    // A phone is not a narrow desktop: a compact viewport shows ONE pane, so the
    // conversation must fill the screen, the composer must be reachable, and the
    // way back to the contact list must exist at all.
    //
    // Both orientations, because width alone was the wrong condition: a phone in
    // LANDSCAPE is 852 wide and 393 tall, sailed past every "phone" breakpoint,
    // and got the old stacked layout — contact list on screen, conversation
    // somewhere below the fold, nothing scrolling. That is what a user reported.
    for (const [w, h, label] of [[390, 780, 'portrait'], [852, 393, 'landscape']] as const) {
    await B.resize(w, h)
    // Enough transcript to overflow at this size. Re-opening a contact clears
    // the messages box, so without this the scroll assertion measures an empty
    // list rather than the layout.
    await B.eval(`
      const box = document.getElementById('messages');
      for (let i = 0; i < 12; i++) {
        const row = document.createElement('div'); row.className = 'mrow ' + (i % 2 ? 'out' : 'in');
        row.dataset.ts = String(Date.now());
        row.innerHTML = '<div class="bubble"><div class="b-text">wypełniacz ' + i + '</div><div class="b-meta">12:00 UTC</div></div>';
        box.appendChild(row);
      }
      box.scrollTop = box.scrollHeight;
      return 1;
    `)
    const phone = await B.eval<any>(`
      const app = document.getElementById('app'), m = document.getElementById('messages');
      const back = document.getElementById('btn-back'), comp = document.querySelector('.composer');
      const cr = comp.getBoundingClientRect();
      return {
        onePane: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
        chatOpen: app.classList.contains('chat-open'),
        backVisible: back.getBoundingClientRect().height > 0,
        composerInView: cr.bottom <= window.innerHeight + 1,
        transcriptScrolls: m.scrollHeight > m.clientHeight,
        appFitsViewport: app.getBoundingClientRect().height <= window.innerHeight + 1,
        appHeight: getComputedStyle(app).height + ' / viewport ' + window.innerHeight,
      };
    `)
    console.log(`   ${label}: ` + JSON.stringify(phone))
    for (const [k, want] of [['onePane', true], ['chatOpen', true], ['backVisible', true], ['composerInView', true], ['transcriptScrolls', true], ['appFitsViewport', true]] as const) {
      if (phone[k] !== want) throw new Error(`phone layout (${label}): ${k} was ${phone[k]}, expected ${want}`)
    }
    await B.eval(`document.getElementById('btn-back').click(); return 1`)
    const backToList = await B.eval<boolean>(`return getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`)
    if (!backToList) throw new Error(`phone layout (${label}): the back button did not return to the contact list`)
    await openContact(B, 'sim-a') // back into the conversation for the next size
    await B.waitFor('the conversation again', `return document.getElementById('app').classList.contains('chat-open')`, 15_000)
    await sleep(400)
    step(`${label}: one pane, a way back, and a composer above the fold`)
    }
    await B.resize(1200, 800)

    } // end !GROUP_ONLY

    scenario('a group: create, invite over 1:1, and a broadcast reaches the member')
    // A makes a group with sim-b. The Sender-Key Distribution rides the existing
    // A↔B 1:1 ratchet; B joins and hands its own key back; then A's broadcast on
    // the group topic reaches B (§8, all-ECDH, deniable).
    await A.eval(`document.getElementById('tab-groups').click(); document.querySelector('#pane-groups .add-btn').click(); return 1`)
    await A.waitFor('the new-group modal', `return document.getElementById('group-modal').classList.contains('open')`, 6_000)
    await A.eval(`
      document.getElementById('group-name').value = 'Testowa';
      const cb = [...document.querySelectorAll('#group-members .gmember')].find((r) => r.textContent.includes('sim-b'))?.querySelector('input');
      if (!cb) throw new Error('sim-b is not selectable as a member');
      cb.checked = true;
      document.getElementById('group-create').click(); return 1;
    `)
    await A.waitFor('A opened the group view', `return document.getElementById('peer-name').textContent.includes('Testowa')`, 10_000)
    await B.waitFor('B received the group invite', `return !!document.querySelector('#pane-groups .contact')`, 40_000)
    step('group created on A, invite delivered to B over the 1:1 ratchet')

    const gmsg = `grupa-${Date.now().toString(36)}`
    let groupDelivered = false
    for (let i = 0; i < 10 && !groupDelivered; i++) {
      await A.eval(`document.getElementById('msg-input').value = ${JSON.stringify(gmsg)}; document.getElementById('send').click(); return 1`)
      await sleep(4_000)
      groupDelivered = await B.eval<boolean>(`
        const g = document.querySelector('#pane-groups .contact'); if (g) g.click();
        return document.getElementById('messages').textContent.includes(${JSON.stringify(gmsg)});
      `)
    }
    if (!groupDelivered) throw new Error('group broadcast did not reach the member')
    step('a broadcast on the group topic reached the member (with the sender label)')

    scenario('wipeout clears local state and returns to login')
    // The §10 WIPE: a device reset. It must delete every ec-* key (identity +
    // contacts) and drop back to the login form — nothing local survives.
    const beforeKeys = await B.eval<number>(`return Object.keys(localStorage).filter((k) => k.startsWith('ec-')).length`)
    if (beforeKeys === 0) throw new Error('precondition: B has no ec-* state to wipe')
    await B.eval(`document.getElementById('btn-settings').click(); return 1`)
    await B.waitFor('the settings drawer', `return document.getElementById('drawer').classList.contains('open')`, 5_000)
    // confirm() is auto-accepted; the handler then wipes and reloads, so this eval
    // may lose its context to the navigation — tolerate that, the waitFor confirms it.
    await B.eval(`window.confirm = () => true; document.getElementById('btn-wipeout').click(); return 1`).catch(() => {})
    await B.waitFor('B back at the login form', `return !!document.getElementById('go-soft') && document.getElementById('app').hidden`, 15_000)
    const afterKeys = await B.eval<number>(`return Object.keys(localStorage).filter((k) => k.startsWith('ec-')).length`)
    if (afterKeys !== 0) throw new Error(`wipeout left ${afterKeys} ec-* key(s) behind`)
    step(`wipeout cleared ${beforeKeys} ec-* key(s) and returned to login`)

    if (GROUP_ONLY) {
      console.log(`\nPASS — group scenario (GROUP_ONLY: the WebRTC/other scenarios were skipped)`)
      process.exitCode = 0
    } else {
      console.log(`\nPASS — all scenarios${direct ? ' (content over WebRTC Direct)' : ' — but WebRTC never came up, see above'}`)
      if (!direct) {
        // Staying on the relay is a result, not a crash, so nothing would have
        // printed — and then the one question worth answering ("why?") needs a
        // whole rerun. The signalling trace is what answers it.
        for (const b of [A, B]) {
          const lines = b.console.filter((l) => /webrtc|rtc|signal|ice|probe/i.test(l))
          console.log(`\n--- ${b.name}: signalling trace ---`)
          console.log(lines.slice(-25).join('\n') || '(nothing — the plane never said a word)')
        }
      }
      process.exitCode = direct ? 0 : 1
    }
  } catch (e: any) {
    console.log(`\nFAIL — ${e?.message ?? e}`)
    for (const b of [A, B]) {
      console.log(`\n--- ${b.name} console (last 40 lines) ---`)
      console.log(b.console.slice(-40).join('\n') || '(empty)')
    }
    process.exitCode = 1
  } finally {
    await Promise.all([A.stop(), B.stop()])
    server?.close()
  }
}

await main()

// A test harness must not outlive its own verdict. This one did: it printed
// PASS and then sat there for as long as it was left running, which in CI is a
// green result inside a job that eventually gets killed for timing out.
// Closing the CDP socket and the local server was not enough — by the time we
// get here the process holds no sockets at all — so the exit is explicit, and
// whatever is still registered gets named rather than silently forced away.
const held = [...new Set(process.getActiveResourcesInfo())].filter((r) => r !== 'TTYWrap' && r !== 'FileHandle')
if (held.length) console.log(`(forced exit — event loop still held by: ${held.join(', ')})`)
await new Promise((r) => process.stdout.write('', r)) // let the verdict reach a pipe first
process.exit(process.exitCode ?? 0)
