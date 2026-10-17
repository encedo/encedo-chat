import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue, RESEND_AFTER_MS, LOST_AFTER_MS } from '../cli/queue.ts'

// bs2-bot -> antek3a, 2026-10-17: a report was handed to the room, no ack came
// (a phone asleep), the room's loop gave up, and the entry stayed "in flight"
// for hours next to a contact that was online - nothing offered it again.

function rig(o: { resendOk?: boolean } = {}) {
  let t = 1_000_000
  const listeners: any[] = []
  const sent: string[] = [], resent: string[] = []
  let n = 0
  const hub: any = {
    online: new Set(['P']), groups: null,
    on: (cb: any) => { listeners.push(cb); return () => {} },
    find: (who: string) => (who === 'ewa' ? { name: 'ewa', pub: 'P' } : undefined),
    nameOf: () => 'ewa',
    send: async (_pub: string, text: string) => { sent.push(text); return { status: 'queued', id: 'm' + ++n, to: 'ewa' } },
    resend: async (_pub: string, id: string) => { resent.push(id); return o.resendOk ?? true },
  }
  const names: any = { fixed: { outbox: 'ob' }, kid: 'k' }
  const kv: any = { get: () => null, set: () => {}, keys: () => [] }
  const q = new Queue({ hub, kv, base: null, names, now: () => t })
  const tick = () => (q as any).tick()
  const deliver = (id: string) => { for (const l of listeners) l({ t: 'delivered', to: 'ewa', pub: 'P', id, ms: 5 }) }
  return { q, hub, sent, resent, tick, deliver, adv: (ms: number) => { t += ms } }
}

test('an entry in flight is offered again under its own id once a minute has passed, and leaves on its ack', async () => {
  const r = rig()
  await r.q.load()
  const s = await r.q.submit('ewa', 'raport 18:00', { waitMs: 1 })
  assert.equal(s.status, 'queued')
  assert.deepEqual(r.sent, ['raport 18:00'])
  await r.tick()
  assert.deepEqual(r.resent, [], 'not before RESEND_AFTER_MS')
  r.adv(RESEND_AFTER_MS + 1)
  await r.tick()
  assert.deepEqual(r.resent, ['m1'], 'offered again, same id - no duplicate on the other side')
  assert.equal(r.sent.length, 1, 'not sent as a new message')
  r.deliver('m1')
  assert.equal(r.q.list().length, 0, 'the ack of the re-send empties the queue')
})

test('a recipient offline is left alone: no re-send until they are back', async () => {
  const r = rig()
  await r.q.load()
  await r.q.submit('ewa', 'x', { waitMs: 1 })
  r.hub.online.delete('P')
  r.adv(RESEND_AFTER_MS + 1)
  await r.tick()
  assert.deepEqual(r.resent, [])
  r.hub.online.add('P')
  await r.tick()
  assert.deepEqual(r.resent, ['m1'])
})

test('an id the room no longer knows is sent again as new after LOST_AFTER_MS', async () => {
  const r = rig({ resendOk: false })
  await r.q.load()
  await r.q.submit('ewa', 'x', { waitMs: 1 })
  r.adv(RESEND_AFTER_MS + 1)
  await r.tick()
  assert.equal(r.sent.length, 1, 'false is also "still trying" - wait')
  r.adv(LOST_AFTER_MS)
  await r.tick()
  assert.equal(r.sent.length, 2, 'given up on the old id, sent anew')
  r.deliver('m2')
  assert.equal(r.q.list().length, 0)
})
