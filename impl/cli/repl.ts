/**
 * repl.ts — minimal IRC-style terminal chat UI (readline).
 *
 * Handles the classic problem of async incoming lines clobbering the input line:
 * print() clears the current input, writes the line, then restores the prompt
 * and whatever the user was typing.
 *
 * Two optional hooks:
 *   onSigint  — Ctrl+C is handed to the caller (graceful shutdown) instead of an
 *               immediate exit. Without it, Ctrl+C closes the readline as before.
 *   onActivity— fires on every keypress (TTY only), so the session can drive
 *               "typing…" / idle-"away" meta-messages.
 */

import { createInterface, emitKeypressEvents, type Interface } from 'node:readline'

export interface Repl {
  print: (line: string) => void
  close: () => void
}
export interface ReplOpts {
  onSigint?: () => void
  onActivity?: () => void
}

export function startRepl(prompt: string, onLine: (line: string) => void, opts: ReplOpts = {}): Repl {
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
  rl.on('SIGINT', () => { if (opts.onSigint) opts.onSigint(); else rl.close() })
  rl.on('close', () => { process.stdout.write('\n'); process.exit(0) })

  if (opts.onActivity && (process.stdin as any).isTTY) {
    emitKeypressEvents(process.stdin)
    process.stdin.on('keypress', () => opts.onActivity!())
  }

  rl.prompt()
  return { print, close: () => rl.close() }
}
