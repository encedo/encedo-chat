/**
 * cli-queue-test.ts - the daemon's notification queue over the real relays
 * (CLI-PLAN.md stage 4b).
 *
 *   node net/cli-queue-test.ts
 *
 * ala runs the daemon with its queue; bob is offline at first. Checked: keyed
 * notifications merge while waiting, a short TTL expires, the queue survives a
 * daemon RESTART (sealed in the store) and drops what expired meanwhile, the
 * queue goes out by itself when bob comes online - merged, in order - and an
 * online recipient gets one message per key per window.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { Hub } from '../cli/hub.ts'
import { Queue } from '../cli/queue.ts'
import { serve, connectDaemon, ask } from '../cli/daemon.ts'
import { cacheBaseOf } from '../lib/localbook.ts'
import { identityKey } from '../cli/profiles.ts'
import type { KV } from '../lib/migrate.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 90_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(200) }
}
const hubFor = (id: Identity, contacts: Array<{ name: string; pub: string }>) => {
  let book = contacts.slice()
  return new Hub({ id, relays, contacts: localOnlyManager(localContactBook(() => book, (l) => { book = l })) })
}
const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }
const sockPath = join(mkdtempSync(join(process.env.HOME!, 'ec-logs', 'queue-')), 'q.sock')
async function req(o: unknown) { const s = (await connectDaemon(sockPath))!; const r = await ask(s, o); s.destroy(); return r }

let failed = false
try {
  const ala = await browserSoftwareIdentity('ala', () => null, () => {})
  const bob = await browserSoftwareIdentity('bob', () => null, () => {})
  const kv = memKV(), kid = await identityKey(ala.pub), base = await cacheBaseOf(ala, kid, kv)
  const logs: string[] = []
  async function daemon() {
    const hub = hubFor(ala, [{ name: 'bob', pub: bob.pub }])
    await hub.start()
    const queue = new Queue({ hub, kv, base, kid, log: (m) => logs.push(m) })
    await queue.load()
    const srv = await serve(hub, sockPath, () => {}, queue)
    return { hub, queue, srv, stop: async () => { queue.stop(); await queue.save(); srv.close(); await hub.close() } }
  }
  let D = await daemon()
  step('daemon with its queue; bob offline')

  const st = [] as string[]
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) st.push((await req({ op: 'send', to: 'bob', text: `login z ${ip}`, key: 'ssh', wait: 3000 })).status)
  st.push((await req({ op: 'send', to: 'bob', text: 'backup gotowy', wait: 3000 })).status)
  st.push((await req({ op: 'send', to: 'bob', text: 'stare', ttl: 2000, wait: 3000 })).status)
  if (st.join() !== 'queued,merged,merged,queued,queued') throw new Error('statuses: ' + st.join())
  const q1 = (await req({ op: 'queue' })).entries
  if (q1.length !== 3 || q1[0].merged !== 2 || q1[0].text !== 'login z 3.3.3.3') throw new Error('queue: ' + JSON.stringify(q1))
  step('offline: three "ssh" logins merge into one entry (+2), a plain one and a short-TTL one wait beside it')

  if (kv.get('ec-outbox-' + kid)?.includes('login z')) throw new Error('the queue on disk is not sealed')
  await D.stop(); await sleep(2500)
  D = await daemon()
  const q2 = (await req({ op: 'queue' })).entries
  if (q2.length !== 2 || q2.some((e: any) => e.text === 'stare')) throw new Error('after restart: ' + JSON.stringify(q2))
  if (!logs.some((l) => l.includes('przeterminowane') && l.includes('stare'))) throw new Error('the expired entry was not reported')
  step('daemon restarted: the queue came back from the sealed store; the expired one was dropped and reported')

  const B = hubFor(bob, [{ name: 'ala', pub: ala.pub }])
  const got: string[] = []
  B.on((e) => { if (e.t === 'msg') got.push(e.text) })
  await B.start()
  await until('bob receives the queue', () => got.length >= 2, 120_000)
  if (got[0] !== 'login z 3.3.3.3 (+2 wcześniejszych)' || got[1] !== 'backup gotowy') throw new Error('received: ' + JSON.stringify(got))
  await until('the queue empties', () => D.queue.outbox.entries.length === 0, 30_000)
  step('bob online: the queue went out by itself - merged, in order - and is empty')

  // "ssh" just went out from the queue, so its window is running: it waits.
  const s1 = await req({ op: 'send', to: 'bob', text: 'login z 4.4.4.4', key: 'ssh', wait: 30_000 })
  if (s1.status !== 'queued') throw new Error('ssh inside its window should wait, got ' + s1.status)
  // A fresh key: the first goes at once, the next inside its window waits to merge.
  const a = await req({ op: 'send', to: 'bob', text: 'dysk 91%', key: 'disk', wait: 30_000 })
  const b = await req({ op: 'send', to: 'bob', text: 'dysk 93%', key: 'disk', wait: 30_000 })
  if (a.status !== 'delivered' || b.status !== 'queued') throw new Error(`online throttle: ${a.status}, ${b.status}`)
  await until('bob got the first disk alert', () => got.includes('dysk 91%'))
  if (got.includes('dysk 93%') || got.includes('login z 4.4.4.4')) throw new Error('a throttled alert went out inside its window')
  step('bob online: one message per key per window - the first "disk" at once, the next waits; "ssh" waits for the window its queue delivery opened')

  await B.close(); await D.stop()
  console.log('PASS - the notification queue over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
}
process.exit(failed ? 1 : 0)
