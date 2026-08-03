import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failoverDial } from '../lib/core.ts'

// The failover sweep behind the node-list (3b). `failoverDial` is pure over an
// injected dialer, so the order, the fall-through and the per-candidate timeout
// are pinned here without a real transport.

test('failoverDial: prefers the primary — first candidate wins, the rest are untried', async () => {
  const tried: string[] = []
  const got = await failoverDial(['a', 'b', 'c'], async (addr) => { tried.push(addr) })
  assert.equal(got, 'a')
  assert.deepEqual(tried, ['a']) // once 'a' connects, 'b'/'c' are never dialed
})

test('failoverDial: a dead primary falls through to the next live node', async () => {
  const tried: string[] = []
  const got = await failoverDial(['dead', 'live'], async (addr) => {
    tried.push(addr)
    if (addr === 'dead') throw new Error('ECONNREFUSED')
  })
  assert.equal(got, 'live')
  assert.deepEqual(tried, ['dead', 'live'])
})

test('failoverDial: every candidate down → throws the LAST error', async () => {
  await assert.rejects(
    failoverDial(['x', 'y'], async (addr) => { throw new Error(`down:${addr}`) }),
    /down:y/,
  )
})

test('failoverDial: a hung node times out and the sweep moves on', async () => {
  const tried: string[] = []
  const got = await failoverDial(
    ['hang', 'live'],
    (addr, signal) => new Promise<void>((resolve, reject) => {
      tried.push(addr)
      // 'hang' never resolves on its own — only the per-candidate timeout ends it,
      // exactly the "operation was aborted" a blocked path shows.
      if (addr === 'hang') signal.addEventListener('abort', () => reject(new Error('aborted')))
      else resolve()
    }),
    30, // 30 ms per-candidate timeout
  )
  assert.equal(got, 'live')
  assert.deepEqual(tried, ['hang', 'live'])
})

test('failoverDial: an empty candidate list throws rather than hanging', async () => {
  await assert.rejects(failoverDial([], async () => {}), /no relay candidates/)
})
