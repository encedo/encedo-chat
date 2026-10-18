/**
 * profiledir.ts - where a harness puts a throwaway Chromium profile.
 *
 * Ubuntu's Chromium is a snap, and a snap has a PRIVATE /tmp: a profile made
 * under the host's /tmp is written into /tmp/snap-private-tmp/snap.chromium/,
 * which the harness's rmSync never reaches. Repeated runs left 9.2 GB there and
 * the disk quota ran out (EDQUOT). `~/snap/chromium/common` is the same
 * directory on both sides, so removing the profile removes it. Profiles that a
 * killed run left behind are swept at the next start.
 */
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const STALE_MS = 6 * 3600_000

function base(): string {
  const snap = join(homedir(), 'snap', 'chromium', 'common')
  if (!existsSync(snap)) return tmpdir()
  const dir = join(snap, 'ec-profiles')
  mkdirSync(dir, { recursive: true })
  return dir
}

let swept = false

/** A new empty profile directory, `ec-<name>-XXXXXX`, that the browser and this process both see. */
export function profileDir(name: string): string {
  const b = base()
  if (!swept) {
    swept = true
    const now = Date.now()
    for (const f of readdirSync(b)) {
      if (!f.startsWith('ec-')) continue
      try { if (now - statSync(join(b, f)).mtimeMs > STALE_MS) rmSync(join(b, f), { recursive: true, force: true }) } catch {}
    }
  }
  return mkdtempSync(join(b, `ec-${name}-`))
}
