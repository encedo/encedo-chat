import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foreignMembers, OwedInvites } from '../web/src/groupview.ts'

test('a member who is not my contact is named; I and my contacts are not', () => {
  const roster = [{ pub: 'admin' }, { pub: 'me' }, { pub: 'friend' }, { pub: 'stranger' }]
  assert.deepEqual(foreignMembers(roster, 'me', new Set(['admin', 'friend'])), ['stranger'])
  assert.deepEqual(foreignMembers(roster, 'me', new Set(['admin', 'friend', 'stranger'])), [], 'all contacts: nobody to warn about')
  assert.deepEqual(foreignMembers(roster, undefined, new Set()), ['admin', 'me', 'friend', 'stranger'], 'no session: nobody is "me"')
})

test('an invitation stays owed until that member hands back its own key at the same epoch', () => {
  const o = new OwedInvites()
  o.invite('g', 1, ['antek', 'ewa'])
  assert.equal(o.isOwed('g', 'antek'), true)
  assert.equal(o.receipt('g', 'stranger', 1), false, 'somebody not owed settles nothing')
  assert.equal(o.receipt('g', 'antek', 0), false, 'a key for an older epoch is not a receipt for this one')
  assert.equal(o.isOwed('g', 'antek'), true)
  assert.equal(o.receipt('g', 'antek', 1), true)
  assert.equal(o.isOwed('g', 'antek'), false)
  assert.deepEqual(o.owedFor('g'), ['ewa'])
  assert.equal(o.receipt('g', 'ewa', 2), true, 'a newer epoch implies they have the group')
  assert.deepEqual(o.owedFor('g'), [])
})

test('a rekey makes everybody owed again; an older invite cannot shrink a newer debt', () => {
  const o = new OwedInvites()
  o.invite('g', 1, ['antek'])
  o.receipt('g', 'antek', 1)
  o.invite('g', 2, ['antek', 'ewa'])
  assert.deepEqual(o.owedFor('g').sort(), ['antek', 'ewa'])
  o.invite('g', 1, ['zombie'])
  assert.equal(o.isOwed('g', 'zombie'), false, 'a late invite for epoch 1 must not touch epoch 2')
  assert.deepEqual(o.groupsOwing('ewa'), ['g'])
})

test('the owed list survives the cache round trip, and garbage in the blob is ignored', () => {
  const o = new OwedInvites()
  o.invite('g', 3, ['antek'])
  const back = new OwedInvites()
  back.load('g', JSON.parse(JSON.stringify(o.toJSON('g'))))
  assert.equal(back.isOwed('g', 'antek'), true)
  for (const junk of [null, 'x', { epoch: '3', pubs: ['a'] }, { epoch: 3, pubs: 'a' }, { epoch: 3, pubs: [1, 2] }]) {
    const j = new OwedInvites(); j.load('g', junk)
    assert.deepEqual(j.owedFor('g'), [], `not trusted: ${JSON.stringify(junk)}`)
  }
  assert.equal(new OwedInvites().toJSON('g'), undefined, 'nothing owed, nothing written')
})
