/**
 * termqr.ts - a QR code drawn in the terminal, readable by a phone camera.
 *
 * The matrix is lib/qr.ts's (the same encoder the app draws its codes with).
 * Two module rows share one text line through half blocks, so the code keeps
 * its square shape in a terminal whose cells are twice as tall as they are
 * wide. Dark modules on a light ground, forced with ANSI colours: a terminal
 * with a dark theme would otherwise draw the code inverted, and many scanners
 * do not read an inverted code. A quiet zone of QUIET modules surrounds it.
 */

import { qrMatrix } from '../lib/qr.ts'

const QUIET = 2
const ON = '\x1b[30;47m', OFF = '\x1b[0m'   // black on white, then reset

/** The code as lines of half blocks, without colour (what the tests read back). */
export function qrBlocks(text: string): string[] {
  const m = qrMatrix(text)
  const n = m.length + 2 * QUIET
  const dark = (r: number, c: number) => {
    const rr = r - QUIET, cc = c - QUIET
    return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr][cc] === 1
  }
  const lines: string[] = []
  for (let r = 0; r < n; r += 2) {
    let line = ''
    for (let c = 0; c < n; c++) {
      const top = dark(r, c), bottom = r + 1 < n && dark(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines
}

/** Ready to print: every line coloured, so the light ground is really light. */
export const qrForTerminal = (text: string): string => qrBlocks(text).map((l) => ON + l + OFF).join('\n')
