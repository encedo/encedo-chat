/**
 * phone-shot.ts — screenshots of the real app at real phone sizes.
 *
 *   node net/phone-shot.ts [outdir]
 *
 * A layout bug on a phone is a *visual* fact: assertions about computed styles
 * miss overlap, clipping and text that runs off the edge, all of which are
 * obvious in a picture. This drives the same headless Chromium the browser test
 * uses, with device metrics for the phones people actually hold, logs in with a
 * software identity, opens a conversation, and writes PNGs.
 *
 * Sizes are CSS pixels at the device's own scale factor — an iPhone 16 is 393×852
 * at DPR 3, a Galaxy S24 is 360×780 at DPR 3 — plus the keyboard case, which is
 * where a chat app usually falls apart.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'

const OUT = process.argv[2] ?? '/tmp/phone-shots'
const DIST = join(import.meta.dirname, '..', 'web', 'dist')
const PORT = 9344
const CHROME = process.env.CHROME ?? '/usr/bin/chromium-browser'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const DEVICES = [
  { name: 'iphone16', width: 393, height: 852, dpr: 3 },
  { name: 'galaxy-s24', width: 360, height: 780, dpr: 3 },
  // Measured on a real Android 15 phone: Chrome leaves 641 CSS px of
  // viewport, Brave 545. The gap between them is browser chrome, and it is
  // what made a max-height rule fire in one browser and not the other.
  { name: 'android15-chrome', width: 360, height: 641, dpr: 3 },
  { name: 'android15-brave', width: 360, height: 545, dpr: 3 },
  { name: 'galaxy-s24-ultra', width: 412, height: 915, dpr: 3 },
  // The one that broke: wider than any "phone" breakpoint, and 393 tall.
  { name: 'iphone16-landscape', width: 852, height: 393, dpr: 3 },
  { name: 'tablet-portrait', width: 820, height: 1180, dpr: 2 },
]

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
function serve(): Server {
  const srv = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
    let body: Buffer | null = null
    try { body = readFileSync(file) } catch { body = null }
    if (!body) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  })
  srv.listen(PORT, '127.0.0.1')
  return srv
}

class Chrome {
  proc!: ChildProcess
  ws!: WebSocket
  sessionId!: string
  dir!: string
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

  async start(url: string) {
    this.dir = mkdtempSync(join(tmpdir(), 'ec-shot-'))
    this.proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const endpoint = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const t = setTimeout(() => reject(new Error('no CDP endpoint')), 25_000)
      this.proc.stderr?.on('data', (c: Buffer) => {
        buf += c.toString()
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) { clearTimeout(t); resolve(m[1]) }
      })
    })
    this.ws = new WebSocket(endpoint)
    await new Promise<void>((res) => this.ws.addEventListener('open', () => res(), { once: true }))
    this.ws.addEventListener('message', (ev: any) => {
      const msg = JSON.parse(String(ev.data))
      const w = this.waiting.get(msg.id)
      if (w) { this.waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result) }
    })
    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find((t: any) => t.type === 'page')
    this.sessionId = (await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
    await this.send('Runtime.enable', {}, true)
  }

  send(method: string, params: any = {}, session = false): Promise<any> {
    const id = this.next++
    const payload: any = { id, method, params }
    if (session && this.sessionId) payload.sessionId = this.sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000)
    })
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${expression} })()`, awaitPromise: true, returnByValue: true }, true)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.value
  }

  async waitFor(what: string, expression: string, ms = 30_000) {
    const t0 = Date.now()
    for (;;) {
      if (await this.eval(expression)) return
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
      await sleep(200)
    }
  }

  async device(width: number, height: number, dpr: number) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dpr, mobile: true,
      screenWidth: width, screenHeight: height,
    }, true)
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, true)
    await sleep(400)
  }

  async shot(file: string) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, true)
    writeFileSync(file, Buffer.from(data, 'base64'))
  }

  async stop() {
    try { this.ws.send(JSON.stringify({ id: this.next++, method: 'Browser.close', params: {} })) } catch {}
    await sleep(700)
    try { this.ws.close() } catch {}
    try { this.proc.kill('SIGKILL') } catch {}
    try { rmSync(this.dir, { recursive: true, force: true }) } catch {}
  }
}

if (!existsSync(join(DIST, 'index.html'))) { console.error('no build — run: npm run web:build'); process.exit(2) }
mkdirSync(OUT, { recursive: true })
const server = serve()
const c = new Chrome()
const url = `http://127.0.0.1:${PORT}/?eh2=1`

try {
  await c.start(url)
  for (const d of DEVICES) {
    await c.device(d.width, d.height, d.dpr)
    await c.eval(`localStorage.clear(); return 1`)
    await c.send('Page.navigate', { url }, true)
    await sleep(1200)
    await c.device(d.width, d.height, d.dpr)

    await c.waitFor('login form', `return !!document.getElementById('go-soft')`)
    await c.shot(join(OUT, `${d.name}-1-login.png`))

    await c.eval(`document.getElementById('handle').value = 'ala'; document.getElementById('go-soft').click(); return 1`)
    await c.waitFor('app shell', `return document.getElementById('app') && !document.getElementById('app').hidden`)
    // A contact to look at (never answers — this is about layout, not networking).
    await c.eval(`
      const pub = btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>(i*7+13)&255)));
      localStorage.setItem('ec-local-contacts-ala', JSON.stringify([{name:'Bartek Nowak', pub}]));
      return 1;
    `)
    await c.send('Page.navigate', { url }, true)
    await sleep(1200)
    await c.eval(`document.getElementById('handle').value = 'ala'; document.getElementById('go-soft').click(); return 1`)
    await c.waitFor('contact list', `return !!document.querySelector('#pane-contacts .contact')`)
    await c.shot(join(OUT, `${d.name}-2-contacts.png`))

    await c.eval(`document.querySelector('#pane-contacts .contact').click(); return 1`)
    await sleep(1500)
    // Some transcript to lay out.
    await c.eval(`
      const box = document.getElementById('messages');
      for (let i = 0; i < 6; i++) {
        const row = document.createElement('div'); row.className = 'mrow ' + (i % 2 ? 'out' : 'in');
        row.dataset.ts = String(Date.now());
        row.innerHTML = '<div class="bubble"><div class="b-text">' +
          (i % 2 ? 'Odpowiedź numer ' + i + ' — trochę dłuższa, żeby zawijanie było widać.' : 'Wiadomość ' + i) +
          '</div><div class="b-meta">12:0' + i + ' UTC</div><div class="b-reactions"></div></div>';
        box.appendChild(row);
      }
      box.scrollTop = box.scrollHeight;
      return 1;
    `)
    await sleep(300)
    await c.shot(join(OUT, `${d.name}-3-chat.png`))

    // …and the case that breaks chat apps: the software keyboard.
    await c.eval(`document.getElementById('msg-input').focus(); return 1`)
    await c.send('Emulation.setVisibleSize', { width: d.width, height: Math.round(d.height * 0.55) }, true).catch(() => {})
    await sleep(600)
    await c.shot(join(OUT, `${d.name}-4-keyboard.png`))
    console.log(`${d.name}: 4 shots`)
  }
} finally {
  await c.stop()
  server.close()
}
console.log(`\nwritten to ${OUT}`)
process.exit(0)
