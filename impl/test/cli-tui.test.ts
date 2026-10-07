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
  assert.deepEqual(decodeKeys('/q b\t'), [{ t: 'text', s: '/q b' }, { t: 'tab' }])
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

import { Screen, statusLine, wrap, visible } from '../cli/tui.ts'
import { VT } from './vt.ts'

test('screen: lines scroll inside the region and never touch the status or the input', () => {
  const vt = new VT(8, 30)
  const sc = new Screen(vt)
  sc.start()
  sc.status('[status line]')
  sc.input('[vostro1] ', 'draft', 5)
  for (let i = 1; i <= 9; i++) sc.appendLine('line ' + i)
  const s = vt.screen()
  assert.deepEqual(s.slice(0, 6), ['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9'], 'the newest six fill the region, oldest scrolled off')
  assert.equal(s[6], '[status line]', 'the status row survives scrolling')
  assert.equal(s[7], '[vostro1] draft', 'and so does the input row')
})

test('screen: a window redraw shows its newest lines, wrapped, bottom-aligned', () => {
  const vt = new VT(6, 10)
  const sc = new Screen(vt)
  const w = new Windows()
  w.print(1, 'one'); w.print(1, 'two'); w.print(1, 'abcdefghijKLM')
  sc.start(); sc.drawWindow(w.current())
  assert.deepEqual(vt.screen().slice(0, 4), ['one', 'two', 'abcdefghij', 'KLM'])
})

test('screen: the input scrolls sideways to keep the cursor visible', () => {
  const vt = new VT(5, 20)
  const sc = new Screen(vt)
  sc.input('> ', 'x'.repeat(30) + 'END', 33)
  assert.ok(vt.line(5).endsWith('END'), vt.line(5))
  assert.equal(vt.c, 20, 'the cursor sits after the last visible character')
})

test('status line: identity, node and link, the window, a lock when secured, and activity', () => {
  const w = new Windows()
  const a = w.open('query', 'p', 'vostro1'); w.open('group', 'g', 'grp1')
  w.switchTo(a.n); w.print(3, '@ala', 'mention')
  const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, '')
  const st = { clock: '22:42', me: 'ala', kind: 'HEM', node: 'bs1', online: true, secure: true }
  assert.equal(plain(statusLine(st, w)), '[22:42] [ala·HEM] [bs1 ●] [2:vostro1 🔐] [Act: 3]')
  assert.equal(plain(statusLine({ ...st, secure: false }, w)), '[22:42] [ala·HEM] [bs1 ●] [2:vostro1] [Act: 3]', 'no lock before EH-2')
  assert.ok(statusLine(st, w).includes('\x1b[35m'), 'a mention is drawn in magenta')
})

test('wrap and visible ignore colour codes', () => {
  assert.equal(visible('\x1b[33mabc\x1b[0m'), 3)
  assert.deepEqual(wrap('\x1b[33mabcdef', 4).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')), ['abcd', 'ef'])
})
