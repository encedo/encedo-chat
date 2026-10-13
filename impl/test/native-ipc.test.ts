/**
 * native-ipc.test.ts - the native host engine, driven the way a shell drives it.
 *
 * eh2/native.ts calls the Tauri commands of src-tauri/src/core_native.rs. Here
 * those commands run in `examples/core-ipc` - the same source file behind
 * Tauri's MOCK runtime - so every call goes through Tauri's real command
 * dispatch: argument names and their camelCase mapping, JSON shapes, error
 * strings. Nothing else covered that seam, and the first run of this file
 * found it broken: native.ts sent snake_case keys, every command with
 * arguments was refused, and every shell since 0.7.27 had quietly fallen back
 * to WASM.
 *
 * The binary is built by `cargo build --example core-ipc` in src-tauri (CI's
 * native-ipc job). Without it the file skips - unless NATIVE_IPC=1, where a
 * missing binary is a failure, so CI cannot pass by not building it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startHandshake, setCoreBackend, coreStatus, type Eh2Handshake, type StartOpts } from '../eh2/establish.ts'
import { startHandshakeNative } from '../eh2/native.ts'
import { startHandshakeWasm } from '../eh2/wasm.ts'
import { x25519FromPriv, type Dh } from '../lib/x25519.ts'
import type { Session } from '../lib/session.ts'

const BIN = fileURLToPath(new URL('../src-tauri/target/debug/examples/core-ipc' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url))
const REQUIRED = process.env.NATIVE_IPC === '1'
const have = existsSync(BIN)
if (!have && REQUIRED) throw new Error(`NATIVE_IPC=1 but ${BIN} is not built (cargo build --example core-ipc in src-tauri)`)
const skip = have ? false : 'examples/core-ipc not built (cargo build --example core-ipc in impl/src-tauri)'

let host: ChildProcess | null = null
const pending = new Map<number, { res(v: unknown): void; rej(e: unknown): void }>()
let nextId = 1
const calls: Array<{ cmd: string; err?: unknown }> = []

function startHost() {
  host = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  host.stdout!.on('data', (d: Buffer) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line)
      const p = pending.get(m.id); if (!p) continue
      pending.delete(m.id)
      if ('err' in m) p.rej(m.err); else p.res(m.ok)
    }
  })
  // What a Tauri webview has: an invoke that resolves with the command's value
  // or rejects with its error value (a string here, as core_native returns).
  ;(globalThis as any).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> = {}) => new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { res, rej: (e: unknown) => { calls.push({ cmd, err: e }); rej(e) } })
      calls.push({ cmd })
      host!.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n')
    }),
  }
}
function stopHost() {
  delete (globalThis as any).__TAURI_INTERNALS__
  host?.stdin?.end(); host?.kill(); host = null
}

const te = new TextEncoder(), td = new TextDecoder()
const fill = (v: number) => new Uint8Array(32).fill(v)
const TAG = fill(0x7a)
type Engine = 'native' | 'ts' | 'wasm'
const start = (e: Engine, o: StartOpts) => e === 'native' ? startHandshakeNative(o) : e === 'wasm' ? startHandshakeWasm(o) : startHandshake(o)

async function establish(eI: Engine, eR: Engine, ratchet = { pqEverySteps: 1 }): Promise<{ I: Session; R: Session }> {
  const ikI: Dh = await x25519FromPriv(fill(0x11)), ikR: Dh = await x25519FromPriv(fill(0x22))
  const hi: Eh2Handshake = await start(eI, { role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: TAG, ratchet })
  const hr: Eh2Handshake = await start(eR, { role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG, ratchet })
  const msg2 = (await hr.feed(hi.initial[0]))!
  assert.equal(hr.authenticated, false, 'R must not trust I before msg3')
  const msg3 = (await hi.feed(msg2))!
  assert.equal(await hr.feed(msg3), null)
  assert.ok(hi.authenticated && hr.authenticated)
  return { I: await hi.session, R: await hr.session }
}
async function say(from: Session, to: Session, text: string) {
  const pt = await to.decrypt(await from.encrypt(te.encode(text)))
  assert.ok(pt, `${text} did not open`); assert.equal(td.decode(pt!), text)
}
/** A conversation that crosses DH steps, hybrid steps (K = 1) and a burst. */
async function talk(I: Session, R: Session) {
  for (const [w, t] of [['I', 'a'], ['R', 'b'], ['I', 'c'], ['R', 'd'], ['I', 'e1'], ['I', 'e2'], ['I', 'e3'], ['R', 'f']] as const) {
    await (w === 'I' ? say(I, R, t) : say(R, I, t))
  }
  // out of order, then a replay that must open nothing
  const f1 = await I.encrypt(te.encode('x1')), f2 = await I.encrypt(te.encode('x2'))
  assert.equal(td.decode((await R.decrypt(f2))!), 'x2')
  assert.equal(td.decode((await R.decrypt(f1))!), 'x1')
  assert.equal(await R.decrypt(f1), null, 'a replay opens nothing')
  const bad = (await I.encrypt(te.encode('x3'))).slice(); bad[bad.length - 1] ^= 1
  assert.equal(await R.decrypt(bad), null, 'a tampered frame opens nothing')
}

test('native host engine through Tauri dispatch', { skip }, async (t) => {
  startHost()
  try {
    await t.test('every command is accepted - no argument refused by name', async () => {
      calls.length = 0
      const { I, R } = await establish('native', 'native')
      await talk(I, R)
      const refused = calls.filter((c) => c.err !== undefined)
      assert.deepEqual(refused, [], `commands refused by the host: ${JSON.stringify(refused)}`)
      for (const cmd of ['core_version', 'core_initiate', 'core_peer_ek', 'core_initiator_complete', 'core_respond',
        'core_responder_complete', 'core_responder_finish', 'core_session', 'core_encrypt', 'core_decrypt']) {
        assert.ok(calls.some((c) => c.cmd === cmd), `${cmd} was never exercised`)
      }
    })
    for (const [i, r] of [['native', 'ts'], ['ts', 'native'], ['native', 'wasm'], ['wasm', 'native']] as const) {
      await t.test(`interop: ${i} initiator, ${r} responder - handshake, hybrid steps, out of order`, async () => {
        const { I, R } = await establish(i, r)
        await talk(I, R)
      })
    }
    await t.test('the host refuses what it must, in the words the room reads', async () => {
      const ikI = await x25519FromPriv(fill(0x11)), ikR = await x25519FromPriv(fill(0x22)), stranger = await x25519FromPriv(fill(0x99))
      // A msg1 whose tag is over a stranger's key: not the contact.
      const hs = await startHandshake({ role: 'initiator', ik: stranger, peerIkPub: ikR.pub, tagKey: TAG })
      const hr = await startHandshakeNative({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
      await assert.rejects(hr.feed(hs.initial[0]), /does not match the contact/)
      // A msg1 from our own identity: a second window.
      const own = await startHandshake({ role: 'initiator', ik: ikR, peerIkPub: ikR.pub, tagKey: TAG })
      const hr2 = await startHandshakeNative({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
      await assert.rejects(hr2.feed(own.initial[0]), /second window/)
      // A tampered msg2 at the initiator.
      const hi = await startHandshakeNative({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub, tagKey: TAG })
      const hr3 = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub, tagKey: TAG })
      const msg2 = (await hr3.feed(hi.initial[0]))!.slice(); msg2[40] ^= 1
      await assert.rejects(hi.feed(msg2), /mac_r/)
    })
    await t.test('the process switch lands on the host and stays there - no fallback', async () => {
      setCoreBackend('native')
      try {
        const { I, R } = await establish('ts', 'ts')   // `start('ts')` = startHandshake, which the switch routes
        await say(I, R, 'routed')
        const s = coreStatus()
        assert.equal(s.used, 'native', `the handshake ran on ${s.used}`)
        assert.deepEqual(s.fallbacks, [], `fell back: ${JSON.stringify(s.fallbacks)}`)
      } finally { setCoreBackend('ts') }
    })
  } finally { stopHost() }
})
