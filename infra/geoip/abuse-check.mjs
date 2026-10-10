#!/usr/bin/env node
// abuse-check.mjs - check an abuse list without touching anything (onchato-block
// runs it before every push): every line parses, which entries are active and
// which have expired. Exit 1 if any line does not parse.
//
//   node infra/geoip/abuse-check.mjs <file> [--today YYYY-MM-DD]
import { readFileSync, existsSync } from 'node:fs'
import { parseAbuseList } from './geoip.mjs'

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const ti = process.argv.indexOf('--today')
const today = ti > 0 ? process.argv[ti + 1] : new Date().toISOString().slice(0, 10)
if (!file) { console.error('usage: abuse-check.mjs <file> [--today YYYY-MM-DD]'); process.exit(2) }
const p = parseAbuseList(existsSync(file) ? readFileSync(file, 'utf8') : '', today)
const row = (tag, e) => console.log(`${tag}  ${e.text.padEnd(40)} ${e.until ? `until ${e.until}` : 'no end'.padEnd(16)}  ${e.comment}`)
for (const e of p.active) row('active ', e)
for (const e of p.expired) row('expired', e)
for (const b of p.invalid) console.log(`INVALID  line ${b.line}: ${b.why}`)
console.log(`${p.active.length} active, ${p.expired.length} expired, ${p.invalid.length} invalid (${today})`)
process.exit(p.invalid.length ? 1 : 0)
