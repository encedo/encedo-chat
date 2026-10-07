/**
 * keys.ts - raw terminal input into key events, and a one-line editor.
 *
 * The terminal is in raw mode, so a chunk from stdin is bytes: printable text
 * (UTF-8, possibly several characters pasted at once), control characters,
 * and escape sequences. irssi's window keys are Alt+digit, which a terminal
 * sends as ESC followed by the digit. Kept free of I/O so it can be tested.
 */

export type Key =
  | { t: 'text'; s: string }
  | { t: 'enter' } | { t: 'backspace' } | { t: 'delete' } | { t: 'tab' }
  | { t: 'left' } | { t: 'right' } | { t: 'home' } | { t: 'end' }
  | { t: 'up' } | { t: 'down' } | { t: 'pgup' } | { t: 'pgdn' }
  | { t: 'alt-digit'; n: number }
  | { t: 'ctrl'; c: 'c' | 'd' | 'u' | 'w' | 'l' | 'a' | 'e' }

const CSI: Record<string, Key> = {
  '[A': { t: 'up' }, '[B': { t: 'down' }, '[C': { t: 'right' }, '[D': { t: 'left' },
  '[H': { t: 'home' }, '[F': { t: 'end' }, '[1~': { t: 'home' }, '[4~': { t: 'end' },
  '[3~': { t: 'delete' }, '[5~': { t: 'pgup' }, '[6~': { t: 'pgdn' },
  'OH': { t: 'home' }, 'OF': { t: 'end' },
}
const CTRL: Record<string, Key> = {
  '\x03': { t: 'ctrl', c: 'c' }, '\x04': { t: 'ctrl', c: 'd' }, '\x15': { t: 'ctrl', c: 'u' },
  '\x17': { t: 'ctrl', c: 'w' }, '\x0c': { t: 'ctrl', c: 'l' }, '\x01': { t: 'ctrl', c: 'a' }, '\x05': { t: 'ctrl', c: 'e' },
}

export function decodeKeys(chunk: string): Key[] {
  const out: Key[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ t: 'text', s: text }); text = '' } }
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]
    if (ch === '\x1b') {
      flush()
      const rest = chunk.slice(i + 1)
      if (/^[0-9]/.test(rest)) { out.push({ t: 'alt-digit', n: Number(rest[0]) }); i += 1; continue }
      const seq = Object.keys(CSI).find((s) => rest.startsWith(s))
      if (seq) { out.push(CSI[seq]); i += seq.length; continue }
      // An unknown sequence: swallow up to its final byte rather than typing it.
      const m = rest.match(/^\[[0-9;]*[A-Za-z~]/)
      if (m) i += m[0].length
      continue
    }
    if (ch === '\r' || ch === '\n') { flush(); out.push({ t: 'enter' }); continue }
    if (ch === '\x7f' || ch === '\b') { flush(); out.push({ t: 'backspace' }); continue }
    if (ch === '\t') { flush(); out.push({ t: 'tab' }); continue }
    if (CTRL[ch]) { flush(); out.push(CTRL[ch]); continue }
    if (ch < ' ') continue // other control bytes are not text
    text += ch
  }
  flush()
  return out
}

/** The input line: text, a cursor, and history. Works in code points. */
export class LineEditor {
  private chars: string[] = []
  cursor = 0
  private history: string[] = []
  private hpos = 0

  get text(): string { return this.chars.join('') }

  /** Apply a key; returns a submitted line on Enter, else null. */
  apply(k: Key): string | null {
    switch (k.t) {
      case 'text': { const add = [...k.s]; this.chars.splice(this.cursor, 0, ...add); this.cursor += add.length; break }
      case 'backspace': if (this.cursor > 0) { this.chars.splice(this.cursor - 1, 1); this.cursor-- } break
      case 'delete': this.chars.splice(this.cursor, 1); break
      case 'left': this.cursor = Math.max(0, this.cursor - 1); break
      case 'right': this.cursor = Math.min(this.chars.length, this.cursor + 1); break
      case 'home': this.cursor = 0; break
      case 'end': this.cursor = this.chars.length; break
      case 'ctrl':
        if (k.c === 'a') this.cursor = 0
        if (k.c === 'e') this.cursor = this.chars.length
        if (k.c === 'u') { this.chars.splice(0, this.cursor); this.cursor = 0 }
        if (k.c === 'w') {
          let i = this.cursor
          while (i > 0 && this.chars[i - 1] === ' ') i--
          while (i > 0 && this.chars[i - 1] !== ' ') i--
          this.chars.splice(i, this.cursor - i); this.cursor = i
        }
        break
      case 'up': if (this.hpos > 0) { this.hpos--; this.set(this.history[this.hpos]) } break
      case 'down':
        if (this.hpos < this.history.length - 1) { this.hpos++; this.set(this.history[this.hpos]) }
        else { this.hpos = this.history.length; this.set('') }
        break
      case 'enter': {
        const line = this.text
        if (line.trim()) { this.history.push(line); if (this.history.length > 200) this.history.shift() }
        this.hpos = this.history.length
        this.set('')
        return line
      }
    }
    return null
  }

  /** Replace the whole line (tab completion). */
  set(s: string) { this.chars = [...s]; this.cursor = this.chars.length }
}
