/**
 * browser-test.ts — drive the REAL web app in two headless browsers.
 *
 *   node net/browser-test.ts                       # against production
 *   APP_URL=http://localhost:3000/?eh2=1 node net/browser-test.ts
 *
 * Everything else we run is Node, and Node has no RTCPeerConnection — so the
 * WebRTC data plane, the one that actually carries content in a browser once
 * two peers meet, was covered by nothing but manual clicking. This closes that:
 * two Chromium instances with separate profiles (separate identities), the
 * deployed bundle, the real relay, and the app driven through its own DOM.
 *
 * Speaks CDP over a WebSocket directly — no Puppeteer, no new dependency; Node
 * 24 has WebSocket built in and Chromium is already on the machine.
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
import { tmpdir } from 'node:os'
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
const HEADFUL = process.env.HEADFUL === '1'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A Chromium instance plus the CDP session for its one page. */
class Browser {
  proc!: ChildProcess
  ws!: WebSocket
  sessionId!: string
  dir!: string
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  readonly console: string[] = []

  // no parameter properties: Node runs this .ts in strip-only mode
  name: string
  port: number
  constructor(name: string, port: number) { this.name = name; this.port = port }

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

  async waitFor<T>(what: string, expression: string, ms = 30_000): Promise<T> {
    const t0 = Date.now()
    for (;;) {
      const v = await this.eval<T>(expression)
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: timed out waiting for ${what}`)
      await sleep(250)
    }
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

const step = (msg: string) => console.log(`• ${msg}`)
const scenario = (name: string) => console.log(`\n▸ ${name}`)

const BADGE_GREEN = `return document.getElementById('e2e-badge').textContent.includes('ratchet') ? document.getElementById('e2e-badge').textContent : ''`
const send = (b: Browser, text: string) => b.eval(`
  const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(text)};
  document.getElementById('send').click(); return 1;
`)
const seen = (text: string) => `return document.getElementById('messages').textContent.includes(${JSON.stringify(text)})`

/** Log in with the software identity already in this profile's localStorage. */
async function login(b: Browser, handle: string) {
  await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
  await b.eval(`(document.getElementById('handle')).value = ${JSON.stringify(handle)}; document.getElementById('go-soft').click();`)
  await b.waitFor('contact list', `return !!document.querySelector('#pane-contacts .contact')`)
}

/** Click a contact by its visible name. */
async function openContact(b: Browser, name: string) {
  await b.eval(`
    const el = [...document.querySelectorAll('#pane-contacts .contact')]
      .find((c) => c.textContent.includes(${JSON.stringify(name)}));
    if (!el) throw new Error('no contact ' + ${JSON.stringify(name)});
    el.click(); return 1;
  `)
}

/** One message each way — the check that a conversation is genuinely alive. */
async function roundTrip(A: Browser, B: Browser, tag: string) {
  const a = `A-${tag}-${Date.now().toString(36)}`
  await send(A, a)
  await B.waitFor(`A→B (${tag})`, seen(a), 25_000)
  const b = `B-${tag}-${Date.now().toString(36)}`
  await send(B, b)
  await A.waitFor(`B→A (${tag})`, seen(b), 25_000)
}

async function main() {
  const A = new Browser('A', 0)
  const B = new Browser('B', 0)
  const server = SERVE_LOCAL ? serveDist() : null
  if (server) step(`serving this checkout's web/dist on 127.0.0.1:${LOCAL_PORT}`)
  try {
    scenario('setup — two browsers, two identities, one room')
    step(`launching Chromium ×2 on ${APP_URL}`)
    await Promise.all([A.start(APP_URL), B.start(APP_URL)])

    for (const [b, handle] of [[A, 'sim-a'], [B, 'sim-b']] as const) {
      await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
      await b.eval(`(document.getElementById('handle')).value = ${JSON.stringify(handle)}; document.getElementById('go-soft').click();`)
      await b.waitFor('app shell', `return document.getElementById('app') && !document.getElementById('app').hidden`)
    }
    const pubA = await A.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id')).pub`)
    const pubB = await B.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id')).pub`)
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

    scenario('messages both ways, with delivery confirmations')
    await roundTrip(A, B, 'first')
    await A.waitFor('delivery mark on A', `return document.getElementById('messages').textContent.includes('dostarczone')`, 20_000)
    await B.waitFor('delivery mark on B', `return document.getElementById('messages').textContent.includes('dostarczone')`, 20_000)
    step('both sides show ✓ dostarczone (ack path works in a browser)')

    scenario('transport upgrade to a direct DataChannel')
    let direct = (await A.eval<string>(`return document.getElementById('transport-badge').textContent`)).includes('Direct')
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
    const hide = (b: Browser, hidden: boolean) => b.eval(`
      Object.defineProperty(document, 'hidden', { value: ${hidden}, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: ${hidden ? "'hidden'" : "'visible'"}, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return 1;
    `)
    await hide(B, true)
    try { await B.send('Page.setWebLifecycleState', { state: 'frozen' }, true) } catch { /* best effort: not all builds allow it */ }
    await sleep(12_000)
    try { await B.send('Page.setWebLifecycleState', { state: 'active' }, true) } catch {}
    await hide(B, false)
    await roundTrip(A, B, 'after-background')
    step('messages flow after 12 s in the background')

    scenario('switching to another contact and back')
    await openContact(A, 'ghost')          // a peer that will never answer
    await sleep(2_000)
    await openContact(A, 'sim-b')          // …and back to the real conversation
    await A.waitFor('EH-2 after switching back', BADGE_GREEN, 45_000)
    await roundTrip(A, B, 'after-switch')
    step('the original conversation resumed after switching away')

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

    console.log(`\nPASS — all scenarios${direct ? ' (content over WebRTC Direct)' : ' — but WebRTC never came up, see above'}`)
    process.exitCode = direct ? 0 : 1
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
