/**
 * rtc-spike.ts — the browser half of the webrtc-rs interop question.
 *
 * Spawns `cargo run --example rtc-spike` (impl/src-tauri), starts a tiny HTTP
 * signalling shim on loopback, and points a headless Chromium at a page that
 * creates the offer, opens a DataChannel named 'onchato' (as the app does),
 * pushes a megabyte with backpressure, then says 'done'. Rust reports what it
 * counted; the page reports what Rust echoed back. Both numbers must equal the
 * megabyte, or the spike has failed.
 *
 * No dependencies: Node's http + child_process, and a Chromium that already has
 * to be on the machine for browser-test. No CDP either — the page phones home
 * over the same HTTP shim, which is why there is nothing to drive.
 *
 *   node net/rtc-spike.ts            (from impl/)
 *   MB=8 node net/rtc-spike.ts       (a bigger payload)
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MB = Number(process.env.MB ?? 1)
const CHROMIUM = process.env.CHROMIUM
  ?? ['/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync)
if (!CHROMIUM) { console.error('no chromium found; set CHROMIUM=/path'); process.exit(2) }

const t0 = Date.now()
const log = (m: string) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`)

// ---- Rust side -------------------------------------------------------------
const rust = spawn('cargo', ['run', '-q', '--example', 'rtc-spike'], {
  cwd: new URL('../src-tauri/', import.meta.url).pathname, stdio: ['pipe', 'pipe', 'inherit'],
})
const toPage: string[] = []           // lines from Rust, waiting for the page to poll
let rustResult: any = null
createInterface({ input: rust.stdout! }).on('line', (line) => {
  let v: any; try { v = JSON.parse(line) } catch { return }
  if (v.kind === 'state') { log(`rust: ${JSON.stringify(v)}`); return }
  if (v.kind === 'result') { rustResult = v; log(`rust counted ${v.bytes} B in ${v.ms} ms`); return }
  toPage.push(line)
})
const toRust = (line: string) => rust.stdin!.write(line + '\n')

// ---- the page ---------------------------------------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>rtc-spike</title><script>
(async () => {
  const say = (m) => fetch('/log', { method: 'POST', body: m })
  const up = (o) => fetch('/up', { method: 'POST', body: JSON.stringify(o) })
  say('page loaded; RTCPeerConnection=' + typeof RTCPeerConnection)
  const pc = new RTCPeerConnection({ iceServers: [] })
  const dc = pc.createDataChannel('onchato')
  dc.binaryType = 'arraybuffer'
  pc.onicecandidate = (e) => { if (e.candidate) up({ kind: 'ice', candidate: e.candidate.toJSON() }) }
  pc.onconnectionstatechange = () => say('browser conn=' + pc.connectionState)
  const total = ${MB} * 1024 * 1024, chunk = 64 * 1024
  let echoed = null
  dc.onmessage = (e) => { if (typeof e.data === 'string') echoed = e.data }
  dc.onopen = async () => {
    say('browser dc open')
    // Liveness first, exactly as the app does: 0x00 0x50 must come back 0x00 0x4f.
    const pong = new Promise((res) => { const h = (e) => { const b = new Uint8Array(e.data); if (b.length === 2 && b[0] === 0 && b[1] === 0x4f) { dc.removeEventListener('message', h); res(true) } }; dc.addEventListener('message', h) })
    dc.send(new Uint8Array([0, 0x50]))
    await Promise.race([pong, new Promise((r) => setTimeout(() => r(false), 3000))]).then((ok) => say('pong: ' + ok))
    const body = new Uint8Array(chunk); for (let i = 0; i < chunk; i++) body[i] = i & 255
    const t = performance.now()
    dc.bufferedAmountLowThreshold = 1 << 20
    for (let sent = 0; sent < total; sent += chunk) {
      if (dc.bufferedAmount > 8 << 20) await new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r() } })
      dc.send(body)
    }
    dc.send('done')
    const t1 = performance.now()
    for (let i = 0; i < 100 && echoed === null; i++) await new Promise((r) => setTimeout(r, 100))
    await fetch('/result', { method: 'POST', body: JSON.stringify({ sent: total, ms: Math.round(t1 - t), echoed }) })
  }
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer)
  up({ kind: 'offer', sdp: offer.sdp })
  for (;;) {
    const lines = await (await fetch('/down')).json()
    for (const l of lines) {
      const v = JSON.parse(l)
      if (v.kind === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: v.sdp })
      else if (v.kind === 'ice') { try { await pc.addIceCandidate(v.candidate) } catch (e) { say('ice add failed: ' + e.message) } }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
})()
</script>`

let pageResult: any = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
    if (req.url === '/up') { toRust(body); res.end('ok'); return }
    if (req.url === '/down') { const out = toPage.splice(0); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out)) }
    if (req.url === '/log') { log(body); res.end('ok'); return }
    if (req.url === '/result') { pageResult = JSON.parse(body); res.end('ok'); return }
    res.writeHead(404); res.end()
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as any).port
  log(`shim on 127.0.0.1:${port}; launching chromium`)
  // Under the snap's own directory, not /tmp: a snap-confined Chromium sees a
  // PRIVATE /tmp, so a profile placed there exists only inside the snap and
  // DevToolsActivePort can never be read from here — which is how the CDP
  // goodbye below silently failed and left ten processes behind. Same lesson
  // browser-test learned with Firefox.
  const profile = `${process.env.HOME}/snap/chromium/common/rtc-spike-profile-${process.pid}`
  const errLog = openSync(`/tmp/claude-1000/rtc-spike-chromium-${process.pid}.log`, 'w')
  const chrome = spawn(CHROMIUM!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: ['ignore', 'ignore', errLog] })
  log(`chromium pid ${chrome.pid}, profile ${profile}`)
  chrome.on('error', () => {})
  // Closed the way browser-test closes it: Browser.close over CDP. A signal is
  // not an option — the snap-confined Chromium refuses it (EACCES) and the
  // first runs of this left three gigabytes of headless zombies behind. The
  // debugging port is random; Chromium writes it to DevToolsActivePort in the
  // profile, and Node's own WebSocket is enough to say goodbye politely.
  const stopChrome = async () => {
    try {
      const [portLine, path] = readFileSync(`${profile}/DevToolsActivePort`, 'utf8').trim().split('\n')
      await new Promise<void>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${portLine}${path}`)
        const done = () => { try { ws.close() } catch {} ; res() }
        ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(done, 400) }
        ws.onerror = done
        setTimeout(done, 2000)
      })
    } catch {}
    try { chrome.kill() } catch {}
    // Last resort, from INSIDE the snap's confinement, which is the one place a
    // signal to these processes is allowed from.
    try { spawnSync('snap', ['run', '--shell', 'chromium', '-c', `pkill -9 -f "[r]tc-spike-profile-${process.pid}"`], { timeout: 15_000 }) } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  const deadline = Date.now() + 240_000
  const tick = setInterval(() => {
    if (pageResult && rustResult) {
      clearInterval(tick)
      const want = MB * 1024 * 1024
      const ok = rustResult.bytes === want && pageResult.echoed === `got ${want}`
      console.log(`\nbrowser sent ${pageResult.sent} B in ${pageResult.ms} ms (${(pageResult.sent / 1048576 / (pageResult.ms / 1000)).toFixed(1)} MB/s)`)
      console.log(`rust received ${rustResult.bytes} B; browser saw echo "${pageResult.echoed}"`)
      console.log(ok ? '\nPASS — webrtc-rs <-> Chromium DataChannel, byte counts agree' : '\nFAIL — counts disagree')
      toRust(JSON.stringify({ kind: 'quit' })); server.close(); try { rust.kill() } catch {}
      void stopChrome().then(() => process.exit(ok ? 0 : 1))
    }
    if (Date.now() > deadline) {
      clearInterval(tick); console.log('\nTIMEOUT — no result from both sides'); try { rust.kill() } catch {}
      void stopChrome().then(() => process.exit(1))
    }
  }, 250)
})
