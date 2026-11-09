import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextPresenceFilter, presenceKeeps } from '../lib/presencefilter.ts'

const row = (online: boolean, unseen = 0, active = false) => ({ online, unseen, active })

test('the button steps all -> online -> offline -> all', () => {
  assert.equal(nextPresenceFilter('all'), 'online')
  assert.equal(nextPresenceFilter('online'), 'offline')
  assert.equal(nextPresenceFilter('offline'), 'all')
})

test('all keeps everyone; online and offline split by the dot', () => {
  assert.equal(presenceKeeps('all', row(true)), true)
  assert.equal(presenceKeeps('all', row(false)), true)
  assert.equal(presenceKeeps('online', row(true)), true)
  assert.equal(presenceKeeps('online', row(false)), false)
  assert.equal(presenceKeeps('offline', row(false)), true)
  assert.equal(presenceKeeps('offline', row(true)), false)
})

test('an unread message is never filtered away', () => {
  assert.equal(presenceKeeps('online', row(false, 2)), true)
  assert.equal(presenceKeeps('offline', row(true, 1)), true)
})

test('the open conversation stays on the list when its peer drops offline', () => {
  assert.equal(presenceKeeps('online', row(false, 0, true)), true)
  assert.equal(presenceKeeps('offline', row(true, 0, true)), true)
})
