import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectIdentity, type HemChoice } from '../cli/identity.ts'

const ala = { kid: 'aa11aa11aa11aa11', handle: 'ala' }, bob = { kid: 'bb22bb22bb22bb22', handle: 'bob' }
const ala2 = { kid: 'cc33cc33cc33cc33', handle: 'Ala' }

test('one identity signs in without a question; none means "create one"', async () => {
  let asked = false
  const choose = async () => { asked = true; return null }
  assert.deepEqual(await selectIdentity([bob], undefined, choose), bob)
  assert.equal(asked, false, 'nobody is asked when there is one')
  assert.equal(await selectIdentity([], undefined, choose), null)
})

test('several: the list goes to the picker sorted by handle, and its answer is taken', async () => {
  let shown: HemChoice[] = []
  const got = await selectIdentity([bob, ala], undefined, async (ids) => { shown = ids; return ids[1] })
  assert.deepEqual(shown.map((i) => i.handle), ['ala', 'bob'])
  assert.deepEqual(got, bob)
  await assert.rejects(selectIdentity([bob, ala], undefined, async () => null), /no identity chosen/, 'Enter on the question cancels, it does not pick')
})

test('several with nobody to ask (a script): an error naming them, never a guess', async () => {
  await assert.rejects(selectIdentity([bob, ala]), /holds 2 identities: ala \(aa11aa11\), bob \(bb22bb22\) - name one with --handle/)
})

test('--handle picks by name, case-insensitively; a missing name is an error, a shared one goes to the picker', async () => {
  assert.deepEqual(await selectIdentity([bob, ala], 'BOB'), bob)
  await assert.rejects(selectIdentity([bob, ala], 'ewa'), /no identity called "ewa" here: ala, bob/)
  const got = await selectIdentity([ala, bob, ala2], 'ala', async (ids) => { assert.equal(ids.length, 2); return ids[0] })
  assert.equal(got!.handle.toLowerCase(), 'ala')
  await assert.rejects(selectIdentity([ala, ala2], 'ala'), /several identities are called "ala"/)
})
