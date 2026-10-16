/**
 * cli-daemon-knock-test.ts - invites through the daemon, over the real relays.
 *
 *   node net/cli-daemon-knock-test.ts
 *
 * Two daemons (Hub + socket, in-process), each on a real CLI profile on disk.
 * ala makes an invite with `onchato-cli invites new` WHILE her daemon runs (the
 * daemon makes it - a second process writing store.json beside it was
 * overwritten by the daemon's next save); bob runs `onchato-cli add <ala's invite>` as a
 * separate process, which hands the contact to HIS daemon (no second session),
 * and the daemon knocks - again every 90 s, so a first knock that nobody heard
 * is not the end of it. ala sees the knock with `onchato-cli knocks`, takes it
 * with `onchato-cli accept 1`, and from that moment both talk: no daemon was
 * restarted to learn a new contact (before 0.7.42 both steps needed one).
 * Then the invite must still be in store.json ON DISK after the daemon saved
 * again, and `invites revoke` stops the listening.
 */

import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { localOnlyManager } from '../lib/core.ts'
import { Hub, type HubEvent } from '../cli/hub.ts'
import { serve, connectDaemon, ask } from '../cli/daemon.ts'
import { fileKV } from '../cli/store.ts'
import { createProfile, identityKey } from '../cli/profiles.ts'
import { InviteStore } from '../cli/invites.ts'
import { fingerprint } from '../cli/fp.ts'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'
import { namesFor } from '../lib/storenames.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000) {
  const t0 = Date.now()
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(500) }
}
const PW = 'kot pies dom lampa'
const dir = mkdtempSync(join(process.env.HOME!, 'ec-logs', 'daemon-knock-'))
// Async on purpose: the daemons run in THIS process and must answer the child.
const cli = (args: string[], sock: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const p = spawn('node', [new URL('../cli/onchato.ts', import.meta.url).pathname, ...args], { env: { ...process.env, ONCHATO_SOCKET: sock, ONCHATO_HOME: join(dir, 'nobody') } })
  let stdout = '', stderr = ''
  p.stdout.on('data', (d) => { stdout += d }); p.stderr.on('data', (d) => { stderr += d })
  const t = setTimeout(() => p.kill(), 90_000)
  p.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }) })
})

/** A daemon on a real profile: the same parts `onchato-cli daemon` puts together. */
async function daemon(name: string) {
  const kv = fileKV(join(dir, name))
  const id = await createProfile(kv, name, PW)
  const names = await namesFor(id, await identityKey(id.pub))
  const base = await cacheBaseOf(id, names, kv)
  const { book } = await openLocalBook(names, kv, base)
  return { id, kv, names, base, sock: join(dir, name + '.sock'), hub: new Hub({ id, relays, contacts: localOnlyManager(book), vault: { kv, base, names }, invites: true }) }
}

let failed = false
try {
  const A = await daemon('ala'), B = await daemon('bob')
  const events = { A: [] as HubEvent[], B: [] as HubEvent[] }
  A.hub.on((e) => events.A.push(e)); B.hub.on((e) => events.B.push(e))
  await A.hub.start(); await B.hub.start()
  const srvA = await serve(A.hub, A.sock), srvB = await serve(B.hub, B.sock)
  if (A.hub.desk?.listening() !== 0) throw new Error('ala\'s daemon listens before any invite exists')
  const r0 = await cli(['invites', 'new', 'bot', '--expires', '1h'], A.sock)
  const link = r0.stdout.match(/https:\/\/\S+#i=\S+/)?.[0]
  if (r0.status !== 0 || !link) throw new Error(`invites new via ala's daemon: rc ${r0.status} ${r0.stdout} ${r0.stderr}`)
  if (A.hub.desk?.listening() !== 1) throw new Error('ala\'s daemon does not listen on the invite it just made')
  step('two daemons on real profiles; `onchato-cli invites new` made the invite IN ala\'s daemon, listened on at once')

  const r1 = await cli(['add', link, '--yes', '--note', 'hej'], B.sock)
  if (r1.status !== 0 || !r1.stdout.includes('przez demona')) throw new Error(`add via bob's daemon: rc ${r1.status} ${r1.stdout} ${r1.stderr}`)
  if (!B.hub.contactList.some((c) => c.pub === A.id.pub)) throw new Error('bob\'s daemon did not take the contact live')
  step('`onchato-cli add <invite>` went through bob\'s daemon: contact live, knocked')

  const bobFp = await fingerprint(B.id.pub)
  // The first knock can go unheard; the daemon knocks again every 90 s.
  await until('ala sees the knock', () => events.A.some((e) => e.t === 'knock' && e.fp === bobFp), 200_000)
  const r2 = await cli(['knocks'], A.sock)
  if (r2.status !== 0 || !r2.stdout.includes(bobFp) || !r2.stdout.includes('„hej”')) throw new Error(`knocks: ${r2.stdout} ${r2.stderr}`)
  step(`ala's daemon heard bob knock (${bobFp}); \`onchato-cli knocks\` lists him with the note`)

  const r3 = await cli(['accept', '1'], A.sock)
  if (r3.status !== 0 || !A.hub.contactList.some((c) => c.pub === B.id.pub)) throw new Error(`accept: rc ${r3.status} ${r3.stdout} ${r3.stderr}`)
  step('`onchato-cli accept 1`: bob is ala\'s contact, no restart')

  await until('bob learns ala accepted', () => events.B.some((e) => e.t === 'contact' && e.how === 'accepted'), 120_000)
  if (B.hub.desk!.knockingOn().length) throw new Error('bob still knocking after the acceptance')
  step('bob\'s daemon saw ala appear: acceptance reported, knocking stopped')

  const send = async (d: typeof A, to: string, text: string) => {
    const s = (await connectDaemon(d.sock))!; const r = await ask(s, { op: 'send', to, text, wait: 60_000 }); s.end(); return r
  }
  const ra = await send(A, 'bob', 'witaj'), rb = await send(B, 'ala', 'dzięki')
  if (ra.status !== 'delivered' || rb.status !== 'delivered') throw new Error(`messages: ${JSON.stringify(ra)} ${JSON.stringify(rb)}`)
  step(`messages both ways: delivered (${ra.ms} ms, ${rb.ms} ms)`)

  const r4 = await cli(['knocks'], A.sock)
  if (!r4.stdout.includes('nikt nie puka')) throw new Error('the accepted knock is still listed: ' + r4.stdout)
  const r5 = await cli(['accept', '1'], A.sock)
  if (r5.status === 0) throw new Error('accepting the same knock twice succeeded')
  step('the knock is gone; accepting it again is refused')

  // The accept above was a save by the daemon AFTER the invite was made: read
  // the file fresh, as a new process would.
  const onDisk = await new InviteStore(fileKV(join(dir, 'ala')), A.base, A.names).invites()
  if (!onDisk.some((i) => i.label === 'bot')) throw new Error('the invite is gone from store.json after the daemon saved')
  const r6 = await cli(['invites'], A.sock)
  if (!r6.stdout.includes(link)) throw new Error('`onchato-cli invites` through the daemon does not list it: ' + r6.stdout)
  const r7 = await cli(['invites', 'revoke', '1'], A.sock)
  if (r7.status !== 0 || A.hub.desk!.listening() !== 0) throw new Error(`revoke: rc ${r7.status} ${r7.stdout} ${r7.stderr}; listening ${A.hub.desk!.listening()}`)
  step('the invite survived the daemon\'s next save on disk; `invites` lists it; `invites revoke 1` stopped the listening')

  srvA.close(); srvB.close(); await A.hub.close(); await B.hub.close()
  console.log('PASS - invites through the daemon, no restart, over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
}
process.exit(failed ? 1 : 0)
