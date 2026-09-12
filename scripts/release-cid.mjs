#!/usr/bin/env node
/**
 * release-cid.mjs — co trzeba opublikować, żeby dało się sprawdzić, że serwer
 * oddaje ten kod, który wyszedł z taga.
 *
 *   node scripts/release-cid.mjs                          # z impl/web/dist
 *   node scripts/release-cid.mjs --check https://onchato.com/chat
 *
 * Łańcuch jest krótki, bo aplikacja ma tylko trzy pliki, które przeglądarka
 * może pobrać: `index.html`, bundle i ikonę. A odkąd bundle jest nazwany w
 * HTML-u przez SRI, wystarczy opublikować CID **samego index.html** — on
 * kryptograficznie ręczy za resztę. Ikona się nie wykonuje.
 *
 * `--check` robi to, co robiłby strażnik: pobiera stronę z produkcji i mówi,
 * czy jej CID zgadza się z tym, co właśnie zbudowano. Build jest powtarzalny
 * (sprawdzone między maszynami i wersjami Node), więc rozjazd znaczy podmianę,
 * a nie przypadek — pod warunkiem, że budowano z CZYSTEGO drzewa: `__EC_COMMIT__`
 * dokleja wtedy `+` i hash wychodzi inny.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cidV1Raw } from '../impl/lib/cid.ts'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'impl', 'web', 'dist')
const html = new Uint8Array(readFileSync(join(DIST, 'index.html')))
const mine = await cidV1Raw(html)

const at = process.argv.indexOf('--check')
if (at === -1) {
  const m = new TextDecoder().decode(html).match(/src="(app\.[a-f0-9]+\.bundle\.js)"[^>]*integrity="(sha384-[^"]+)"/)
  if (!m) { console.error('index.html nie ma SRI na bundlu — łańcuch jest niepełny'); process.exit(2) }
  console.log(`index.html  ${mine}`)
  console.log(`  ręczy za  ${m[1]}`)
  console.log(`            ${m[2]}`)
  console.log('\nDo opublikowania w wydaniu wystarczy pierwsza linia.')
  process.exit(0)
}

const url = process.argv[at + 1]
if (!url) { console.error('--check wymaga adresu'); process.exit(2) }
const res = await fetch(url, { cache: 'no-store' })
if (!res.ok) { console.error(`${url} -> HTTP ${res.status}`); process.exit(1) }
const theirs = await cidV1Raw(new Uint8Array(await res.arrayBuffer()))
console.log(`zbudowane: ${mine}`)
console.log(`serwowane: ${theirs}`)
if (mine === theirs) { console.log('\nZGODNE — serwer oddaje to, co wyszło z tego drzewa.'); process.exit(0) }
console.error('\nROZJAZD — serwowany HTML NIE jest tym, co zbudowano z tego drzewa.')
process.exit(1)
