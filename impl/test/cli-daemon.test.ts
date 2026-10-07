import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serve, connectDaemon, ask, lineReader } from '../cli/daemon.ts'

const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'onchato-sock-'))
/** Just enough of a Hub for the socket: sends always "deliver". */
const fakeHub: any = {
  id: { handle: 'ala' }, contactList: [{ name: 'bob', pub: 'p' }], online: new Set(['p']), nameOf: () => 'bob',
  session: { netStatus: () => ({ link: 'online', relay: 'r' }) },
  send: async (to: string) => { if (to !== 'bob') throw new Error(`nie ma kontaktu „${to}”`); return { status: 'delivered', id: 'm1', ms: 5, to } },
  on: () => () => {},
}

test('lines: split across chunks, blank lines skipped, a broken line reported', () => {
  const got: any[] = [], bad: string[] = []
  const feed = lineReader((o) => got.push(o), (l) => bad.push(l))
  feed('{"a":1}\n{"b"'); feed(':2}\n\nnot json\n')
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }])
  assert.deepEqual(bad, ['not json'])
})

test('the socket is private, answers, and refuses bad requests', async () => {
  const path = join(tmp(), 's.sock')
  const srv = await serve(fakeHub, path)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'only this user can talk to it')
  const s = (await connectDaemon(path))!
  assert.deepEqual(await ask(s, { op: 'send', to: 'bob', text: 'x' }), { ok: true, status: 'delivered', id: 'm1', ms: 5, to: 'bob' }); s.end()
  const s2 = (await connectDaemon(path))!
  assert.deepEqual(await ask(s2, { op: 'send', to: 'zed', text: 'x' }), { ok: false, error: 'nie ma kontaktu „zed”' }); s2.end()
  const s3 = (await connectDaemon(path))!
  assert.equal((await ask(s3, { op: 'send', to: 'bob' })).ok, false, 'no text, no send'); s3.end()
  const s4 = (await connectDaemon(path))!
  assert.equal((await ask(s4, { op: 'status' })).me, 'ala'); s4.end()
  srv.close()
})

test('a live daemon is not displaced; a stale socket file is', async () => {
  const path = join(tmp(), 's.sock')
  const srv = await serve(fakeHub, path)
  await assert.rejects(serve(fakeHub, path), /demon już działa/)
  srv.close()
  const stale = join(tmp(), 'stale.sock')
  writeFileSync(stale, '')                       // what a crash can leave behind
  const srv2 = await serve(fakeHub, stale)
  const c = await connectDaemon(stale)
  assert.ok(c, 'the new daemon took the path')
  c!.destroy()
  srv2.close()
  assert.equal(await connectDaemon(join(tmp(), 'none.sock')), null, 'no daemon, no connection')
})
