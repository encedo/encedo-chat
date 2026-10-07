/**
 * tui.ts - the screen of the irssi-style client (CLI-PLAN.md stage 3).
 *
 *   rows 1 .. H-2   the active window, a scroll region (new lines push old up)
 *   row  H-1        the status line
 *   row  H          the input line
 *
 * Plain ANSI, no library: the alternate screen (so the terminal comes back as
 * it was on exit, like irssi or less), a scroll region (DECSTBM) so arriving
 * lines never touch the status or the input, and absolute cursor moves for the
 * two fixed rows. Works over SSH and inside screen/tmux.
 */

import type { Win, Windows } from './windows.ts'

export const ESC = '\x1b'
const csi = (s: string) => ESC + '[' + s
export const SGR = {
  reset: csi('0m'), dim: csi('2m'), bold: csi('1m'), rev: csi('7m'),
  green: csi('32m'), yellow: csi('33m'), magenta: csi('35m'), cyan: csi('36m'), red: csi('31m'), grey: csi('90m'),
  bar: csi('97;42m'),     // the status line: white on green, like the app's accent
}

/** Visible length: escape sequences take no room. (Wide glyphs count as one - good enough.) */
export const visible = (s: string) => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length

/** Split a line into rows of at most `cols` visible characters, keeping escape codes intact. */
export function wrap(line: string, cols: number): string[] {
  if (cols < 1) return [line]
  const out: string[] = []
  let cur = '', n = 0
  for (const tok of line.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? []) {
    if (tok.startsWith('\x1b')) { cur += tok; continue }
    if (n === cols) { out.push(cur); cur = ''; n = 0 }
    cur += tok; n++
  }
  out.push(cur)
  return out
}

export interface StatusState {
  clock: string           // "22:42"
  me: string              // "ala"
  kind: string            // "HEM" | "software"
  node: string            // "bs1"
  online: boolean | null  // link up / down / connecting
  secure: boolean         // the active conversation is secured (EH-2) - shown as a lock
}

/** The status line: [22:42] [ala·HEM] [bs1 ●] [2:vostro1 🔐] [Act: 3,4] */
export function statusLine(s: StatusState, w: Windows): string {
  const cur = w.current()
  const dot = s.online === true ? SGR.green + '●' : s.online === false ? SGR.red + '●' : SGR.yellow + '○'
  const here = `${cur.n}:${cur.title}` + (cur.kind !== 'status' && s.secure ? ' 🔐' : '')
  const act = w.activity()
  const actTxt = act.length
    ? ` [Act: ${act.map((a) => (a.activity === 'mention' ? SGR.magenta + SGR.bold : SGR.yellow) + a.n + SGR.reset + SGR.bar).join(',')}]`
    : ''
  return `${SGR.bar}[${s.clock}] [${s.me}·${s.kind}] [${s.node} ${dot}${SGR.reset}${SGR.bar}] [${SGR.bold}${here}${SGR.reset}${SGR.bar}]${actTxt}`
}

export interface Out { write(s: string): unknown; columns?: number; rows?: number }

export class Screen {
  private out: Out
  constructor(out: Out = process.stdout) { this.out = out }
  get rows() { return Math.max(4, this.out.rows ?? 24) }
  get cols() { return Math.max(20, this.out.columns ?? 80) }
  private get regionBottom() { return this.rows - 2 }

  start() { this.out.write(csi('?1049h') + csi('2J') + csi(`1;${this.regionBottom}r`)) }
  stop() { this.out.write(csi('r') + csi('?1049l')) }

  /** Redraw a whole window (on a switch or a resize): its newest lines, wrapped. */
  drawWindow(win: Win) {
    const rows: string[] = []
    for (let i = win.lines.length - 1; i >= 0 && rows.length < this.regionBottom; i--) {
      rows.unshift(...wrap(win.lines[i], this.cols))
    }
    const shown = rows.slice(-this.regionBottom)
    let s = csi(`1;${this.regionBottom}r`)
    for (let r = 1; r <= this.regionBottom; r++) s += csi(`${r};1H`) + csi('2K')
    const top = this.regionBottom - shown.length + 1
    shown.forEach((l, i) => { s += csi(`${top + i};1H`) + l + SGR.reset })
    this.out.write(s)
  }

  /** One new line in the window on screen: it scrolls in at the bottom of the region. */
  appendLine(line: string) {
    let s = ''
    for (const part of wrap(line, this.cols)) s += csi(`${this.regionBottom};1H`) + '\n' + csi('2K') + part + SGR.reset
    this.out.write(s)
  }

  status(text: string) {
    const pad = Math.max(0, this.cols - visible(text))
    this.out.write(csi(`${this.rows - 1};1H`) + csi('2K') + text + SGR.bar + ' '.repeat(pad) + SGR.reset)
  }

  /** The input line: prompt + text, scrolled sideways so the cursor stays visible. */
  input(prompt: string, text: string, cursor: number) {
    const room = Math.max(1, this.cols - visible(prompt) - 1)
    const chars = [...text]
    const start = Math.max(0, cursor - room)
    const shown = chars.slice(start, start + room).join('')
    this.out.write(csi(`${this.rows};1H`) + csi('2K') + prompt + shown + csi(`${this.rows};${visible(prompt) + (cursor - start) + 1}H`))
  }
}
