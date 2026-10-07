/**
 * vt.ts - a tiny terminal for tests: just enough VT100 to check what the CLI's
 * screen code leaves on screen (cursor moves, erase, scroll regions, line feed
 * scrolling, autowrap). Colours (SGR) are accepted and ignored.
 */
export class VT {
  grid: string[][]
  r = 1; c = 1
  top = 1; bottom: number
  rows: number; cols: number
  constructor(rows: number, cols: number) {
    this.rows = rows; this.cols = cols
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
    this.bottom = rows
  }
  get columns() { return this.cols }
  line(n: number) { return this.grid[n - 1].join('').replace(/\s+$/, '') }
  screen() { return this.grid.map((r) => r.join('').replace(/\s+$/, '')) }
  private lf() {
    if (this.r === this.bottom) { this.grid.splice(this.top - 1, 1); this.grid.splice(this.bottom - 1, 0, Array(this.cols).fill(' ')) }
    else if (this.r < this.rows) this.r++
  }
  write(s: string) {
    const toks = s.match(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]|[\s\S]/gu) ?? []
    for (const t of toks) {
      if (t.startsWith('\x1b[')) {
        const fin = t[t.length - 1], body = t.slice(2, -1)
        const p = body.replace('?', '').split(';').filter(Boolean).map(Number)
        if (fin === 'H') { this.r = p[0] ?? 1; this.c = p[1] ?? 1 }
        else if (fin === 'K') { const from = body === '2' ? 0 : this.c - 1; for (let i = from; i < this.cols; i++) this.grid[this.r - 1][i] = ' ' }
        else if (fin === 'J' && body === '2') this.grid.forEach((row) => row.fill(' '))
        else if (fin === 'r') { this.top = p[0] ?? 1; this.bottom = p[1] ?? this.rows; this.r = 1; this.c = 1 }
        else if (fin === 'h' && body === '?1049') this.grid.forEach((row) => row.fill(' '))
        continue
      }
      if (t === '\n') { this.lf(); continue }
      if (t === '\r') { this.c = 1; continue }
      if (t.startsWith('\x1b')) continue
      if (this.c > this.cols) { this.c = 1; this.lf() }
      this.grid[this.r - 1][this.c - 1] = t
      this.c++
    }
  }
}
