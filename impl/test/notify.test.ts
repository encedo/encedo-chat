/**
 * What earns a system notification, and how much it may say (`lib/notify.ts`).
 *
 * Worth a test rather than a reading because every one of these conditions is a
 * promise: nothing while the window is on screen (a banner for a message the
 * user is looking at), nothing for what we sent ourselves, nothing at all
 * without permission — and, in every mode, no message text. That last one is
 * the reason the plan returns a NAME or nothing, and never a body: a shape that
 * cannot carry the text cannot leak it by a later edit.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planNotification, isNotifyMode, NOTIFY_MODES } from '../lib/notify.ts'

const base = { mode: 'name' as const, granted: true, away: true, mine: false, name: 'Ala' }

test('a notification needs all four: a mode, permission, an unattended window, someone else', () => {
  assert.deepEqual(planNotification(base), { show: true, name: 'Ala' })
  assert.deepEqual(planNotification({ ...base, mode: 'off' }), { show: false })
  assert.deepEqual(planNotification({ ...base, granted: false }), { show: false })
  // The window is the one being used: whatever arrived is on screen already.
  // `away` is focus, not visibility — a visible tab behind another window is
  // away, which is the correction that came out of a live report.
  assert.deepEqual(planNotification({ ...base, away: false }), { show: false })
  assert.deepEqual(planNotification({ ...base, mine: true }), { show: false })
})

test('quiet mode says that something arrived and nothing more', () => {
  assert.deepEqual(planNotification({ ...base, mode: 'quiet' }), { show: true, name: null })
  // Even asked for a name, quiet does not carry one — the caller cannot opt in
  // by passing a better argument.
  assert.deepEqual(planNotification({ ...base, mode: 'quiet', name: 'Ala' }), { show: true, name: null })
})

test('no mode can carry the message text', () => {
  // The plan has room for a name or nothing. There is no field a body could go
  // in, which is the point: the one part of a conversation that leaves the app
  // cannot be the part that quotes it.
  for (const mode of NOTIFY_MODES) {
    const plan = planNotification({ ...base, mode })
    if (!plan.show) continue
    assert.deepEqual(Object.keys(plan).sort(), ['name', 'show'])
  }
})

test('an unknown stored mode is not a mode', () => {
  assert.ok(isNotifyMode('off') && isNotifyMode('name') && isNotifyMode('quiet'))
  assert.ok(!isNotifyMode('all') && !isNotifyMode('') && !isNotifyMode(null) && !isNotifyMode(undefined))
})

test('a missing name degrades to quiet, it does not invent one', () => {
  assert.deepEqual(planNotification({ ...base, name: undefined }), { show: true, name: null })
})
