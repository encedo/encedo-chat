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
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      url,
    ], { stdio: 'ignore' })

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

  /** Chromium prints nothing useful on stdout with --headless=new; poll the HTTP endpoint. */
  private async discover(): Promise<{ browserWs: string }> {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`)
        const j: any = await r.json()
        if (j.webSocketDebuggerUrl) return { browserWs: j.webSocketDebuggerUrl }
      } catch { /* not up yet */ }
      await sleep(150)
    }
    throw new Error(`${this.name}: Chromium did not expose CDP on ${this.port}`)
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

  async reload(url: string) {
    await this.send('Page.navigate', { url }, true)
    await sleep(1200)
  }

  async stop() {
    try { this.proc.kill('SIGKILL') } catch {}
    try { rmSync(this.dir, { recursive: true, force: true }) } catch {}
  }
}

const step = (msg: string) => console.log(`• ${msg}`)

async function main() {
  const A = new Browser('A', 9331)
  const B = new Browser('B', 9332)
  const server = SERVE_LOCAL ? serveDist() : null
  if (server) step(`serving this checkout's web/dist on 127.0.0.1:${LOCAL_PORT}`)
  try {
    step(`launching two Chromium instances on ${APP_URL}`)
    await Promise.all([A.start(APP_URL), B.start(APP_URL)])

    // 1. software identities (no HEM needed for a transport/crypto test)
    for (const [b, handle] of [[A, 'sim-a'], [B, 'sim-b']] as const) {
      await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
      await b.eval(`
        (document.getElementById('handle')).value = ${JSON.stringify(handle)};
        document.getElementById('go-soft').click();
      `)
      await b.waitFor('app shell', `return document.getElementById('app') && !document.getElementById('app').hidden`)
    }
    const pubA = await A.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id')).pub`)
    const pubB = await B.eval<string>(`return JSON.parse(localStorage.getItem('ec-soft-id')).pub`)
    step(`identities ready — A ${pubA.slice(0, 12)}…  B ${pubB.slice(0, 12)}…`)

    // 2. each knows the other (local contact book), then reload to pick it up
    await A.eval(`localStorage.setItem('ec-local-contacts-sim-a', ${JSON.stringify(JSON.stringify([{ name: 'sim-b', pub: pubB }]))}); return 1`)
    await B.eval(`localStorage.setItem('ec-local-contacts-sim-b', ${JSON.stringify(JSON.stringify([{ name: 'sim-a', pub: pubA }]))}); return 1`)
    await Promise.all([A.reload(APP_URL), B.reload(APP_URL)])
    for (const [b, handle] of [[A, 'sim-a'], [B, 'sim-b']] as const) {
      await b.waitFor('login form', `return !!document.getElementById('go-soft')`)
      await b.eval(`(document.getElementById('handle')).value = ${JSON.stringify(handle)}; document.getElementById('go-soft').click();`)
      await b.waitFor('contact list', `return !!document.querySelector('#pane-contacts .contact')`)
    }

    // 3. both open the conversation
    step('opening the room in both browsers')
    await Promise.all([A, B].map((b) => b.eval(`document.querySelector('#pane-contacts .contact').click(); return 1`)))

    // 4. EH-2 must go green on BOTH sides
    const badge = `return document.getElementById('e2e-badge').textContent.includes('ratchet') ? document.getElementById('e2e-badge').textContent : ''`
    const [ba, bb] = await Promise.all([A.waitFor<string>('EH-2 on A', badge, 45_000), B.waitFor<string>('EH-2 on B', badge, 45_000)])
    step(`EH-2 established in both: "${ba.trim()}" / "${bb.trim()}"`)

    // 5. a message each way, through whatever transport the app chose
    const send = (b: Browser, text: string) => b.eval(`
      const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(text)};
      document.getElementById('send').click(); return 1;
    `)
    const seen = (text: string) => `return document.getElementById('messages').textContent.includes(${JSON.stringify(text)})`

    const msgA = `from-A-${Date.now().toString(36)}`
    await send(A, msgA)
    await B.waitFor('A→B message', seen(msgA), 20_000)
    step(`A → B delivered ("${msgA}")`)

    const msgB = `from-B-${Date.now().toString(36)}`
    await send(B, msgB)
    await A.waitFor('B→A message', seen(msgB), 20_000)
    step(`B → A delivered ("${msgB}")`)

    // 6. the delivery confirmation must show up on the sender's own bubble
    await A.waitFor('delivery mark on A', `return document.getElementById('messages').textContent.includes('dostarczone')`, 20_000)
    step('delivery confirmation shown (ack path works in the browser)')

    // 7. and the content should end up on a direct DataChannel
    const transport = await A.eval<string>(`return document.getElementById('transport-badge').textContent`)
    let direct = transport.includes('Direct')
    if (!direct) {
      try {
        await A.waitFor('WebRTC direct', `return document.getElementById('transport-badge').textContent.includes('Direct')`, 25_000)
        direct = true
      } catch { /* reported below */ }
    }
    step(direct ? 'transport upgraded to WebRTC Direct' : '⚠ still on relay — WebRTC did not come up')

    // 8. after the upgrade, messages must still flow (this is the plane Node cannot test)
    const msgC = `after-upgrade-${Date.now().toString(36)}`
    await send(A, msgC)
    await B.waitFor('post-upgrade message', seen(msgC), 20_000)
    step('message delivered after the transport decision')

    console.log(`\nPASS — two real browsers, EH-2 + delivery both ways${direct ? ' over WebRTC Direct' : ' (relay only — see warning above)'}`)
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
