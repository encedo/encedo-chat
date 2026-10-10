import { test } from 'node:test'
import assert from 'node:assert/strict'
import { regionBlocked } from '../lib/regioncheck.ts'

const fake = (answers: Record<string, number | 'throw'>, asked: string[] = []) => (async (url: string) => {
  asked.push(url)
  const a = answers[new URL(url).host]
  if (a === undefined || a === 'throw') throw new TypeError('failed to fetch')
  return { status: a } as Response
}) as unknown as typeof fetch

test('an explicit 451 from a node means blocked', async () => {
  assert.equal(await regionBlocked(['bs1.onchato.com'], { fetch: fake({ 'bs1.onchato.com': 451 }) }), true)
})

test('down nodes, normal answers and CORS-less 200s are not a refusal', async () => {
  const asked: string[] = []
  assert.equal(await regionBlocked(['a.x', 'b.x', 'c.x'], { fetch: fake({ 'a.x': 'throw', 'b.x': 200, 'c.x': 502 }, asked) }), false)
  assert.deepEqual(asked, ['https://a.x/health', 'https://b.x/health', 'https://c.x/health'], 'each node asked once, /health over https')
})

test('one node that says 451 is enough, and at most three are asked', async () => {
  const asked: string[] = []
  assert.equal(await regionBlocked(['a.x', 'a.x', 'b.x', 'c.x', 'd.x'], { fetch: fake({ 'c.x': 451, 'd.x': 451 }, asked) }), true)
  assert.deepEqual(asked.map((u) => new URL(u).host), ['a.x', 'b.x', 'c.x'])
})
