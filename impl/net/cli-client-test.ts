/**
 * cli-client-test.ts - two irssi-style CLI clients talk through the real relays.
 *
 *   node net/cli-client-test.ts
 *
 * Each client runs in its own emulated terminal (test/vt.ts) and is driven by
 * keystrokes; every assertion reads the SCREEN - what a person would see -
 * not internal state. Covers: /query opening a window, EH-2 shown as the lock
 * in the status line, a message arriving on the other screen, activity on the
 * status line when the window is not on screen, Alt+N switching, /verify
 * printing the same safety number on both screens, and /quit.
 */

import { readFileSync } from 'node:fs'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { runClient } from '../cli/client.ts'
import { VT } from '../test/vt.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = false
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 45_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(150) }
}

async function terminal(id: Identity, contacts: Array<{ name: string; pub: string }>) {
  const vt = new VT(24, 100)
  let feed: (s: string) => void = () => {}
  let exited = -1
  let book = contacts.slice()
  const c = await runClient({
    id, kind: 'software', contacts: localOnlyManager(localContactBook(() => book, (l) => { book = l })), relays,
    io: { out: vt, onInput: (cb) => { feed = cb }, exit: (code) => { exited = code } },
  })
  return {
    vt, client: c, type: (s: string) => feed(s),
    screen: () => vt.screen().join('\n'),
    status: () => vt.line(23),
    exited: () => exited,
  }
}

try {
  const ala = await browserSoftwareIdentity('ala', () => null, () => {})
  const bob = await browserSoftwareIdentity('bob', () => null, () => {})
  const A = await terminal(ala, [{ name: 'bob', pub: bob.pub }])
  const B = await terminal(bob, [{ name: 'ala', pub: ala.pub }])
  step('two clients started, each on its own emulated terminal')
  await until('the link shown as up (green dot) on both', () => / ●\]/.test(A.status()) && / ●\]/.test(B.status()), 20_000)
  step('the status line shows the link up from the start')

  // Only ala opens the conversation; bob types nothing and must still get it.
  A.type('/query bob\r')
  await until('window 2 on ala', () => A.status().includes('2:bob'))
  step('/query opens window 2')
  const msg = 'czesc z CLI ' + Date.now().toString(36)
  A.type(msg + '\r')
  await until('bob told on status that ala starts a conversation', () => B.screen().includes('ala zaczyna rozmowę - okno 2'), 60_000)
  await until('activity for that background window on bob\'s status line', () => /Act: 2/.test(B.status()), 60_000)
  if (!B.status().includes('1:status')) throw new Error('the incoming conversation yanked bob\'s view')
  step('an incoming conversation opens in a background window: told on status, "Act: 2", view not moved')
  B.type('\x1b2')
  await until('the message on bob\'s screen', () => B.screen().includes('<ala> ' + msg))
  step('Alt+2 shows the message that started it')
  await until('the lock in both status lines (EH-2)', () => A.status().includes('🔐') && B.status().includes('🔐'), 60_000)
  step('the session is secured: the lock is on both status lines')

  B.type('\x1b1')                                  // Alt+1: bob looks at status
  await until('bob on the status window', () => B.status().includes('1:status'))
  A.type('druga\r')
  await until('activity for window 2 on bob\'s status line', () => /Act: 2/.test(B.status()))
  if (B.screen().includes('<ala> druga')) throw new Error('a message for window 2 was drawn on the status window')
  step('a message for a window not on screen lights "Act: 2" and is not drawn over status')
  B.type('\x1b2')
  await until('switching back shows it and clears the activity', () => B.screen().includes('<ala> druga') && !/Act:/.test(B.status()))
  step('Alt+2 shows it and clears the activity')

  A.type('/verify\r'); B.type('/verify\r')
  const digits = (s: string) => (s.match(/\b\d{5} \d{5} \d{5} \d{5}\b/g) ?? []).join(' ')
  await until('safety numbers on both screens', () => digits(A.screen()).length > 60 && digits(B.screen()).length > 60, 10_000)
  if (digits(A.screen()) !== digits(B.screen())) throw new Error(`safety numbers differ:\n${digits(A.screen())}\n${digits(B.screen())}`)
  step('/verify prints the same safety number on both screens')

  if (process.env.SHOT_DIR) {   // the two screens as text, for a look at the real thing
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.SHOT_DIR + '/cli-ala.txt', A.screen()); writeFileSync(process.env.SHOT_DIR + '/cli-bob.txt', B.screen())
  }
  A.type('/quit\r'); B.type('/quit\r')
  await until('both clients exited', () => A.exited() === 0 && B.exited() === 0, 10_000)
  step('/quit leaves and exits cleanly')
  console.log('PASS - two CLI clients over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
}
process.exit(failed ? 1 : 0)
