import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beginSave, type SaveEnv } from '../lib/saveas.ts'

/**
 * The contract that matters is which errors mean what: a closed dialog is a
 * "no" and nothing is written, anything else the picker throws is not the
 * person's decision and the classic download takes over.
 */
const blob = new Blob(['hello'])
const err = (name: string) => Object.assign(new Error(name), { name })

function env(picker?: SaveEnv['picker']) {
  const downloads: Array<{ blob: Blob; name: string }> = []
  const e: SaveEnv = { picker, download: (b, n) => downloads.push({ blob: b, name: n }) }
  return { e, downloads }
}

test('with a picker, the bytes go through the handle in order and the anchor is not used', async () => {
  const trace: string[] = []
  const { e, downloads } = env(async ({ suggestedName }) => {
    trace.push('pick:' + suggestedName)
    return { createWritable: async () => ({ write: async () => { trace.push('write') }, close: async () => { trace.push('close') } }) }
  })
  const sink = await beginSave('raport.pdf', e)
  assert.equal(sink?.kind, 'picker')
  await sink!.write(blob)
  assert.deepEqual(trace, ['pick:raport.pdf', 'write', 'close'])
  assert.equal(downloads.length, 0)
})

test('closing the dialog is an answer: null, and nothing is written anywhere', async () => {
  const { e, downloads } = env(async () => { throw err('AbortError') })
  assert.equal(await beginSave('x.bin', e), null)
  assert.equal(downloads.length, 0)
})

test('any other refusal by the picker falls back to the classic download', async () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'TypeError']) {
    const { e, downloads } = env(async () => { throw err(name) })
    const sink = await beginSave('x.bin', e)
    assert.equal(sink?.kind, 'download', name)
    await sink!.write(blob)
    assert.deepEqual(downloads, [{ blob, name: 'x.bin' }])
  }
})

test('no picker at all is the classic download, under the given name', async () => {
  const { e, downloads } = env()
  const sink = await beginSave('onchato-a.ecprofile', e)
  assert.equal(sink?.kind, 'download')
  await sink!.write(blob)
  assert.equal(downloads[0].name, 'onchato-a.ecprofile')
})

test('a write that fails in the picker path is reported, not papered over with a second copy', async () => {
  const { e, downloads } = env(async () => ({
    createWritable: async () => ({ write: async () => {}, close: async () => { throw new Error('disk full') } }),
  }))
  const sink = await beginSave('x.bin', e)
  await assert.rejects(() => sink!.write(blob), /disk full/)
  assert.equal(downloads.length, 0)
})

test('discard removes what the picker created, and is harmless everywhere else', async () => {
  let removed = 0
  const { e } = env(async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }), remove: async () => { removed++ } }))
  const sink = await beginSave('x.bin', e)
  await sink!.discard()
  assert.equal(removed, 1)
  const plain = await beginSave('x.bin', env().e)
  await plain!.discard()   // nothing to do, nothing thrown
  const noRemove = await beginSave('x.bin', env(async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) })).e)
  await noRemove!.discard()
})
