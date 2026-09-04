import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignedTimer, setRadioProfile } from '../lib/radiophase.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('timers created at different moments fire in the same instants', async () => {
  // The whole point of the module: two publishers with the same period share
  // their wakes regardless of when each was created. Staggered creation (60 ms
  // apart on a 150 ms period) would keep plain setIntervals ~60 ms apart for
  // ever; aligned timers converge onto one grid. The margin is wide — an
  // order-dependent test needs a margin, not a plausible number — but well
  // under the 60 ms an unaligned pair would show.
  const a: number[] = []
  const b: number[] = []
  const stopA = alignedTimer(() => a.push(Date.now()), 150)
  await sleep(60)
  const stopB = alignedTimer(() => b.push(Date.now()), 150)
  await sleep(650)
  stopA(); stopB()

  assert.ok(a.length >= 3 && b.length >= 3, `too few fires: ${a.length}/${b.length}`)
  const nearest = b.map((t) => Math.min(...a.map((s) => Math.abs(t - s))))
  const median = nearest.sort((x, y) => x - y)[Math.floor(nearest.length / 2)]
  assert.ok(median < 45, `misaligned: median nearest-fire distance ${median} ms`)
})

test('background stretches slowable timers only, and coming back re-arms', async () => {
  setRadioProfile('active')
  try {
    let slow = 0
    let fixed = 0
    const stopS = alignedTimer(() => slow++, 50, { slowable: true })
    const stopF = alignedTimer(() => fixed++, 50)
    setRadioProfile('background') // slowable stretches to 200 ms, fixed stays 50
    await sleep(600)
    const slowInBg = slow
    const fixedInBg = fixed
    setRadioProfile('active')     // re-arm: the slowable one speeds back up
    await sleep(300)
    stopS(); stopF()
    // RELATIVE margin, not absolute counts: the parallel suite stalls the
    // loop and shifts individual fires, but a stall slows both timers alike —
    // the 4x ratio is what the feature promises, so the ratio is what the
    // test pins (with slack for one boundary fire either way).
    assert.ok(fixedInBg >= 6, `fixed fired only ${fixedInBg}×`)
    assert.ok(slowInBg <= fixedInBg / 2, `slowable ${slowInBg}× vs fixed ${fixedInBg}× — not stretched`)
    assert.ok(slow > slowInBg, `never re-armed after coming back (${slow})`)
  } finally { setRadioProfile('active') }
})

test('stop stops, and stopping one leaves the other running', async () => {
  let a = 0
  let b = 0
  const stopA = alignedTimer(() => a++, 40)
  const stopB = alignedTimer(() => b++, 40)
  await sleep(100)
  stopA()
  const aFrozen = a
  await sleep(120)
  stopB()
  assert.equal(a, aFrozen)
  assert.ok(b > aFrozen, `the survivor stalled too: ${b} <= ${aFrozen}`)
})
