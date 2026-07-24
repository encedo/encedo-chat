/**
 * repl.ts — minimal IRC-style terminal chat UI (readline).
 *
 * Handles the classic problem of async incoming lines clobbering the input line:
 * print() clears the current input, writes the line, then restores the prompt
 * and whatever the user was typing.
 */

import { createInterface, type Interface } from 'node:readline'

export interface Repl {
  print: (line: string) => void
  close: () => void
}

export function startRepl(prompt: string, onLine: (line: string) => void): Repl {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, prompt })

  const print = (line: string) => {
    // clear current line, print message, redraw prompt + current input
    process.stdout.write('\r\x1b[K' + line + '\n')
    rl.prompt(true)
  }

  rl.on('line', (line) => {
    const t = line.trim()
    if (t) onLine(t)
    rl.prompt()
  })
  rl.on('SIGINT', () => { rl.close() })
  rl.on('close', () => { process.stdout.write('\n'); process.exit(0) })

  rl.prompt()
  return { print, close: () => rl.close() }
}
