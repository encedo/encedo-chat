/**
 * windows.ts - irssi-style windows, as data (CLI-PLAN.md stage 3).
 *
 * Window 1 is status. Every conversation - a 1:1 or a group - gets the next
 * free number when it opens and keeps it until it is closed; closing leaves a
 * hole rather than renumbering, so "window 3" keeps meaning the same person
 * while you talk (irssi does the same by default).
 *
 * Activity is what the status line shows for windows you are not looking at:
 * 'msg' for a new message, 'mention' (louder) for one that names you, never
 * downgraded by a later plain message, cleared when you switch there. System
 * lines (joins, link state) do not count as activity - they are noise.
 *
 * No terminal code here: the renderer (tui.ts) draws what this decides.
 */

export type WinKind = 'status' | 'query' | 'group'
export type Activity = 'none' | 'msg' | 'mention'

export interface Win {
  n: number
  kind: WinKind
  /** What the window is about: a contact's pub, a group's gid; '' for status. */
  key: string
  title: string
  lines: string[]
  activity: Activity
}

/** Lines kept per window; older ones fall off the top. */
export const SCROLLBACK = 1000

export class Windows {
  private wins = new Map<number, Win>()
  active = 1

  constructor() { this.wins.set(1, { n: 1, kind: 'status', key: '', title: 'status', lines: [], activity: 'none' }) }

  list(): Win[] { return [...this.wins.values()].sort((a, b) => a.n - b.n) }
  get(n: number): Win | undefined { return this.wins.get(n) }
  current(): Win { return this.wins.get(this.active)! }
  byKey(key: string): Win | undefined { return this.list().find((w) => w.key === key && w.kind !== 'status') }
  byTitle(t: string): Win | undefined { return this.list().find((w) => w.title.toLowerCase() === t.toLowerCase()) }

  /** The window for `key`, opening one at the lowest free number if needed. */
  open(kind: Exclude<WinKind, 'status'>, key: string, title: string): Win {
    const have = this.byKey(key); if (have) return have
    let n = 2; while (this.wins.has(n)) n++
    const w: Win = { n, kind, key, title, lines: [], activity: 'none' }
    this.wins.set(n, w)
    return w
  }

  /** Close a conversation window; status cannot be closed. Returns false when nothing closed. */
  close(n: number): boolean {
    if (n === 1 || !this.wins.has(n)) return false
    this.wins.delete(n)
    if (this.active === n) this.active = 1
    return true
  }

  /** Switch; clears that window's activity. False for a window that does not exist. */
  switchTo(n: number): boolean {
    const w = this.wins.get(n); if (!w) return false
    this.active = n; w.activity = 'none'
    return true
  }

  /**
   * Append a line. `level` is what it means for activity when the window is
   * not on screen: 'sys' never lights it, 'msg' lights it, 'mention' lights it
   * louder and is not undone by a later 'msg'.
   */
  print(n: number, line: string, level: 'sys' | 'msg' | 'mention' = 'sys'): void {
    const w = this.wins.get(n); if (!w) return
    w.lines.push(line)
    if (w.lines.length > SCROLLBACK) w.lines.splice(0, w.lines.length - SCROLLBACK)
    if (n === this.active || level === 'sys') return
    if (level === 'mention' || w.activity === 'none') w.activity = level
  }

  /** "Act: 3,4" - the windows with something new, mentions marked for the renderer. */
  activity(): Array<{ n: number; activity: Exclude<Activity, 'none'> }> {
    return this.list().filter((w) => w.activity !== 'none').map((w) => ({ n: w.n, activity: w.activity as Exclude<Activity, 'none'> }))
  }
}
