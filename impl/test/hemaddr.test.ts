import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastHemAddr, rememberHemAddr, HEM_ADDR_KEY, HEM_ADDR_DEFAULT } from '../lib/hemaddr.ts'

function kv() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('nothing remembered: the form starts at my.ence.do', () => {
  assert.equal(lastHemAddr(kv()), HEM_ADDR_DEFAULT)
  assert.equal(HEM_ADDR_DEFAULT, 'https://my.ence.do')
})

test('the last address a device answered on comes back, the newest one wins', () => {
  const s = kv()
  rememberHemAddr(s, ' https://c15.example.ence.do ')
  assert.equal(lastHemAddr(s), 'https://c15.example.ence.do')
  rememberHemAddr(s, 'https://other.ence.do')
  assert.equal(lastHemAddr(s), 'https://other.ence.do')
  assert.equal(s.m.get(HEM_ADDR_KEY), 'https://other.ence.do')
})

test('an empty address is not remembered, a blank record reads as nothing', () => {
  const s = kv()
  rememberHemAddr(s, 'https://a.ence.do')
  rememberHemAddr(s, '   ')
  assert.equal(lastHemAddr(s), 'https://a.ence.do')
  s.m.set(HEM_ADDR_KEY, '  ')
  assert.equal(lastHemAddr(s), HEM_ADDR_DEFAULT)
})

test('a storage that throws costs the convenience, never the sign-in', () => {
  const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
  assert.equal(lastHemAddr(bad), HEM_ADDR_DEFAULT)
  assert.doesNotThrow(() => rememberHemAddr(bad, 'https://a.ence.do'))
})
