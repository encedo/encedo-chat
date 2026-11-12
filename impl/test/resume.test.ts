/**
 * Coming back on screen (lib/core.ts `refresh`): the decision, and the backoff
 * wait it cuts short. Reported 2026-11-12 on Android: after ten hours in the
 * background the header said "reconnecting" for about a minute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumeStep, wakeableWait, PROBE_AFTER_AWAY_MS } from '../lib/core.ts'

const base = { redialing: false, connected: true, awayMs: 0, canProbe: true }

test('resumeStep: a re-dial in progress is woken, not waited for', () => {
  assert.equal(resumeStep({ ...base, redialing: true, connected: false }), 'wake')
  assert.equal(resumeStep({ ...base, redialing: true, awayMs: 10 * 3600_000 }), 'wake')
})

test('resumeStep: no connection is a re-dial', () => {
  assert.equal(resumeStep({ ...base, connected: false }), 'redial')
})

test('resumeStep: a long absence asks the relay, a short one trusts the connection', () => {
  assert.equal(resumeStep({ ...base, awayMs: PROBE_AFTER_AWAY_MS }), 'probe')
  assert.equal(resumeStep({ ...base, awayMs: 10 * 3600_000 }), 'probe')
  assert.equal(resumeStep({ ...base, awayMs: PROBE_AFTER_AWAY_MS - 1 }), 'none')
  assert.equal(resumeStep({ ...base, awayMs: 10 * 3600_000, canProbe: false }), 'none', 'GossipSub has no probe: as before')
})

test('wakeableWait: wake() ends a running wait at once', async () => {
  const w = wakeableWait()
  const t0 = Date.now()
  const p = w.wait(30_000)
  setTimeout(() => assert.equal(w.wake(), true), 10)
  await p
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`)
  assert.equal(w.wake(), false, 'nothing waiting: nothing to wake')
})

test('wakeableWait: without wake() the wait runs its full time', async () => {
  const w = wakeableWait()
  const t0 = Date.now()
  await w.wait(60)
  assert.ok(Date.now() - t0 >= 55, `ended after ${Date.now() - t0} ms`)
})
