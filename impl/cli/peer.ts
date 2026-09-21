/**
 * peer.ts — a software-identity peer for live testing, named on the command line.
 *
 *   node cli/peer.ts bob init
 *   node cli/peer.ts bob add-peer alice <pubB64>
 *   node cli/peer.ts carl join bob
 *
 * This replaced three top-level directories - `bob/` and `carl/` were each a
 * four-line file whose only content was the name and a path, around the one
 * implementation in `software-peer.ts`. A test identity is an ARGUMENT, not a
 * folder; adding a third used to mean adding a directory to the repository.
 *
 * The keystore lives in `cli/keys/<name>.keystore.json`, gitignored like the
 * ones it replaced - it holds a real private key.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { softwarePeerCli } from './software-peer.ts'

const name = process.argv[2]
// Refused rather than defaulted: every command here writes to a keystore, and
// guessing WHICH identity is the one mistake that silently mixes two of them.
if (!name || name.startsWith('-') || name.includes('/')) {
  console.error('usage: node cli/peer.ts <name> <init|pubkey|add-peer|peers|topic|join> [...]')
  process.exit(2)
}
process.argv.splice(2, 1) // the shared CLI reads the verb from argv[2]

const ks = new URL(`./keys/${name}.keystore.json`, import.meta.url).pathname
mkdirSync(dirname(ks), { recursive: true })
await softwarePeerCli(ks, name)
