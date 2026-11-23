/**
 * Opening a conversation replays its log through the live append path, and a
 * live late message (`ooo`) is allowed not to pull the view down. Replayed,
 * that stopped the view on the first late message and counted every message
 * after it in the jump-to-latest badge, again on every entry (2026-11-24).
 * Both entries - 1:1 and group - must replay through replayTranscript, which
 * starts with nothing counted and ends at the newest message.
 * Source checks: the browser harness has no late message in a replayed log.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../web/src/app.ts', import.meta.url), 'utf8')

function body(src: string, head: string): string {
  const start = src.indexOf(head)
  assert.ok(start >= 0, `${head} is gone`)
  const end = src.indexOf('\n}\n', start)
  assert.ok(end > start)
  return src.slice(start, end)
}

test('replayTranscript resets the count, then lands at the bottom and repaints the button', () => {
  const r = body(app, 'function replayTranscript(')
  const replay = r.indexOf('applyEv(ev)')
  assert.ok(replay > 0)
  assert.ok(r.slice(0, replay).includes('unread = 0'), 'a count left from the previous room leaks in')
  const after = r.slice(replay)
  assert.match(after, /box\.scrollTop = box\.scrollHeight/, 'a late message in the log leaves the view mid-transcript')
  assert.match(after, /unread = 0/, 'messages after a late one stay counted as new')
  assert.match(after, /refreshJump\(\)/)
})

test('both the 1:1 and the group entry replay through replayTranscript, and nothing else does', () => {
  assert.match(body(app, 'async function activateRoom('), /replayTranscript\(room\.log\)/)
  assert.equal((app.match(/replayTranscript\(gu\.log\)/g) ?? []).length, 1)
  assert.doesNotMatch(app, /for \(const ev of (room|gu)\.log\) applyEv\(ev\)/, 'a bare replay loop skips the landing')
})
