/**
 * The platform probe (`lib/capabilities.ts`) — and the two things a live report
 * showed it was doing wrong.
 *
 * On WebKitGTK, X25519 failed once, the app said "this browser is not enough",
 * and restarting it fixed the problem. Two defects, both ours:
 *
 *   - the probe ran ONCE, so anything transient became a permanent refusal;
 *   - `catch {}` threw the exception away, so the report could not say whether
 *     the platform had refused, failed, or was simply not ready.
 *
 * Both are pinned here. The WebCrypto path itself is exercised by every other
 * test in the suite; what these check is the probe's behaviour AROUND it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeCapabilities, formatReport, qrDecodeAvailable } from '../lib/capabilities.ts'

/** Swap `crypto.subtle` for the duration of one probe, then put it back. */
async function withSubtle<T>(fake: any, fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle')
  Object.defineProperty(globalThis.crypto, 'subtle', { value: fake, configurable: true })
  try { return await fn() } finally {
    if (real) Object.defineProperty(globalThis.crypto, 'subtle', real)
  }
}

/** The real thing, with `generateKey` failing the first `failures` times. */
function flaky(failures: number, err: Error) {
  const real = globalThis.crypto.subtle
  let seen = 0
  return new Proxy(real, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (typeof v !== 'function') return v
      if (p !== 'generateKey') return v.bind(t)
      return (...args: any[]) => {
        // Only the X25519 probe is made flaky; AES-GCM must stay healthy, or the
        // test would not show WHICH capability recovered.
        if (args[0]?.name === 'X25519' && seen++ < failures) return Promise.reject(err)
        return (v as any).apply(t, args)
      }
    },
  })
}

test('a capability that fails once and then works is NOT a missing capability', async () => {
  const rep = await withSubtle(flaky(1, new Error('backend not ready')), () => probeCapabilities())
  const x = rep.caps.find((c) => c.id === 'X25519')!
  assert.equal(x.ok, true, 'the retry rescued it')
  assert.equal(x.tries, 2, 'and the report says it took two attempts')
  assert.equal(rep.missing.some((m) => m.id === 'X25519'), false)
  assert.ok(formatReport(rep).includes('took 2 attempts'), formatReport(rep))
})

test('a capability that never works is reported missing, with what the platform said', async () => {
  const err = Object.assign(new Error('X25519 not supported'), { name: 'NotSupportedError' })
  const rep = await withSubtle(flaky(99, err), () => probeCapabilities())
  const x = rep.caps.find((c) => c.id === 'X25519')!
  assert.equal(x.ok, false)
  assert.equal(rep.ok, false)
  // The words the platform used are the whole point: without them the last live
  // report of this could not be told apart from "not ready yet".
  assert.match(x.error!, /NotSupportedError: X25519 not supported/)
  assert.ok(formatReport(rep).includes('NotSupportedError'), formatReport(rep))
})

test('retrying costs attempts only where it can help', async () => {
  // Three attempts at 150 ms is under half a second on a platform that really
  // cannot do it — worth paying once, not worth paying per optional feature.
  const err = new Error('nope')
  const t0 = Date.now()
  const rep = await withSubtle(flaky(99, err), () => probeCapabilities())
  const ms = Date.now() - t0
  assert.equal(rep.caps.find((c) => c.id === 'X25519')!.tries, 3)
  assert.ok(ms < 2_000, `a failing probe must not hang the start-up: ${ms} ms`)
  // Optional capabilities are a note, not a retry: they carry no attempt count.
  for (const c of rep.caps.filter((c) => !c.required)) assert.equal(c.tries, undefined)
})

test('the probe tests what the app actually does, not a cheaper subset', async () => {
  // generateX25519() generates, exports the public half, imports it back and
  // derives. A probe that skipped the export would pass on a platform that then
  // failed at runtime — which is the failure mode this file exists to prevent.
  const calls: string[] = []
  // The algorithm sits in a different argument per method — first for
  // generateKey/deriveBits, THIRD for importKey — so look at all of them rather
  // than at a position. exportKey names no algorithm at all and is the X25519
  // probe's alone.
  const mentionsX = (args: any[]) => args.some((a) => a && typeof a === 'object' && a.name === 'X25519')
  const real = globalThis.crypto.subtle
  const spy = new Proxy(real, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (typeof v !== 'function') return v
      return (...args: any[]) => {
        if (mentionsX(args) || p === 'exportKey') calls.push(String(p))
        return (v as any).apply(t, args)
      }
    },
  })
  await withSubtle(spy, () => probeCapabilities())
  for (const step of ['generateKey', 'exportKey', 'importKey', 'deriveBits']) {
    assert.ok(calls.includes(step), `the X25519 probe must ${step}; saw ${calls.join(', ')}`)
  }
})

// ---- can this platform actually decode a QR code? -------------------------
//
// The question the app used to ask was "does the constructor exist", and on
// Chrome for macOS the answer is yes while the answer to the real question is
// no: the button appeared, the camera came on, and nothing was ever resolved
// (reported 2026-09-19). These pin the decision itself, since the platform
// that exposed it cannot be reproduced on the machine running this test.

test('no reader at all is no', async () => {
  assert.equal(await qrDecodeAvailable(undefined), false)
  assert.equal(await qrDecodeAvailable({}), false)          // not even callable
})

test('a reader that cannot be asked what it supports is no', async () => {
  // The method has been in the API from the start, so a constructor without it
  // is not an implementation we can interrogate -- and a camera that may never
  // read anything is the wrong way to be wrong.
  const ctor = function () {} as any
  assert.equal(await qrDecodeAvailable(ctor), false)
})

test('a reader that supports other formats but not QR is no', async () => {
  // Chrome on macOS, the case that shipped a broken button.
  const ctor = function () {} as any
  ctor.getSupportedFormats = async () => ['ean_13', 'code_128']
  assert.equal(await qrDecodeAvailable(ctor), false)
})

test('a reader that lists qr_code is yes', async () => {
  const ctor = function () {} as any
  ctor.getSupportedFormats = async () => ['qr_code', 'ean_13']
  assert.equal(await qrDecodeAvailable(ctor), true)
})

test('a reader that throws when asked is no, not a crash', async () => {
  const ctor = function () {} as any
  ctor.getSupportedFormats = async () => { throw new Error('nope') }
  assert.equal(await qrDecodeAvailable(ctor), false)
})

test('a reader that answers with something that is not a list is no', async () => {
  const ctor = function () {} as any
  ctor.getSupportedFormats = async () => 'qr_code'   // a string CONTAINS it
  assert.equal(await qrDecodeAvailable(ctor), false)
})
