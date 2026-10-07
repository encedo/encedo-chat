import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Windows, SCROLLBACK } from '../cli/windows.ts'
import { decodeKeys, LineEditor } from '../cli/keys.ts'

test('windows: status is 1, conversations take the lowest free number and keep it', () => {
  const w = new Windows()
  assert.equal(w.current().kind, 'status')
  const a = w.open('query', 'pubA', 'vostro1'), b = w.open('group', 'gid1', 'grp1')
  assert.deepEqual([a.n, b.n], [2, 3])
  assert.equal(w.open('query', 'pubA', 'vostro1').n, 2, 'opening again returns the same window')
  assert.equal(w.close(2), true)
  assert.equal(w.get(3)!.title, 'grp1', 'no renumbering after a close')
  assert.equal(w.open('query', 'pubB', 'ewa').n, 2, 'the hole is reused')
  assert.equal(w.close(1), false, 'status cannot be closed')
  assert.equal(w.switchTo(9), false)
})

test('windows: activity lights for windows you are not in, mentions win, switching clears it', () => {
  const w = new Windows()
  const a = w.open('query', 'pubA', 'vostro1'), g = w.open('group', 'gid', 'grp1')
  w.print(a.n, 'joined', 'sys')
  assert.deepEqual(w.activity(), [], 'a system line is not activity')
  w.print(g.n, '@ala hi', 'mention')
  w.print(g.n, 'plain', 'msg')
  w.print(a.n, 'hello', 'msg')
  assert.deepEqual(w.activity(), [{ n: 2, activity: 'msg' }, { n: 3, activity: 'mention' }], 'a later plain message does not downgrade a mention')
  w.switchTo(3)
  assert.deepEqual(w.activity(), [{ n: 2, activity: 'msg' }])
  w.print(3, 'while looking', 'msg')
  assert.deepEqual(w.activity(), [{ n: 2, activity: 'msg' }], 'the window on screen never lights')
})

test('windows: scrollback is capped', () => {
  const w = new Windows()
  for (let i = 0; i < SCROLLBACK + 50; i++) w.print(1, 'l' + i)
  assert.equal(w.get(1)!.lines.length, SCROLLBACK)
  assert.equal(w.get(1)!.lines[0], 'l50')
})

test('keys: text, Alt+digit, arrows, control keys and a paste come apart correctly', () => {
  assert.deepEqual(decodeKeys('abc\r'), [{ t: 'text', s: 'abc' }, { t: 'enter' }])
  assert.deepEqual(decodeKeys('\x1b3'), [{ t: 'alt-digit', n: 3 }])
  assert.deepEqual(decodeKeys('\x1b[A\x1b[D\x1b[3~'), [{ t: 'up' }, { t: 'left' }, { t: 'delete' }])
  assert.deepEqual(decodeKeys('x\x03'), [{ t: 'text', s: 'x' }, { t: 'ctrl', c: 'c' }])
  assert.deepEqual(decodeKeys('zażółć 👍'), [{ t: 'text', s: 'zażółć 👍' }], 'UTF-8 and emoji stay text')
  assert.deepEqual(decodeKeys('\x1b[1;5C'), [], 'an unknown sequence is swallowed, not typed')
  assert.deepEqual(decodeKeys('\x07'), [], 'a stray control byte is not text')
})

test('line editor: editing, words, history, and Enter returns the line', () => {
  const e = new LineEditor()
  const type = (s: string) => decodeKeys(s).map((k) => e.apply(k)).filter((x) => x !== null)
  type('hello word')
  e.apply({ t: 'left' }); e.apply({ t: 'left' }); e.apply({ t: 'left' }); e.apply({ t: 'left' })
  type('l'); assert.equal(e.text, 'hello lword')
  e.apply({ t: 'end' }); e.apply({ t: 'ctrl', c: 'w' }); assert.equal(e.text, 'hello ')
  assert.deepEqual(type('there\r'), ['hello there'])
  assert.equal(e.text, '', 'cleared after Enter')
  type('second\r')
  e.apply({ t: 'up' }); assert.equal(e.text, 'second')
  e.apply({ t: 'up' }); assert.equal(e.text, 'hello there')
  e.apply({ t: 'down' }); e.apply({ t: 'down' }); assert.equal(e.text, '', 'past the newest is an empty line')
  type('ąę'); e.apply({ t: 'backspace' }); assert.equal(e.text, 'ą', 'backspace removes a character, not a byte')
  assert.deepEqual(type('\r'), ['ą'])
  assert.deepEqual(type('   \r'), ['   '], 'a blank line is returned (the caller ignores it) but not kept in history')
  e.apply({ t: 'up' }); assert.equal(e.text, 'ą')
})
