// onchato fput — osiem bajtow miedzy uploadem a magazynem.
//
// `POST /f` jest otwarty dla swiata z rozmyslu: uwierzytelniony upload wiedzialby,
// KTO wyslal CO i KIEDY, czyli dokladnie te metadane, ktorych produkt unika
// (docs/PROTOCOL.md 12, infra/README.md). Cena byla taka, ze pod nasza nazwa dalo
// sie powiesic cudza strone — sprawdzone: plik HTML wgrany curl-em wracal z bramki
// jako `text/html`, na jednym originie z aplikacja uruchomiona z IPFS.
//
// Ten serwis dokleja osiem bajtow do KAZDEGO uploadu, zanim trafi on do Kubo, i
// nikt ich po drodze nie zdejmuje — ani `/f`, ani bramka. Zdejmuje je dopiero nasz
// klient przy deszyfrowaniu (`impl/lib/fileenvelope.ts`). Asymetria jest cala
// mechanika: **co wchodzi, nie jest tym, co wychodzi**, wiec magazyn przestaje
// oddawać cokolwiek 1:1, a przegladarka dostaje `application/octet-stream`
// zamiast strony — Kubo typuje tresc po pierwszych bajtach, a te sa binarne.
//
// Czego to nie robi: nie odmawia. Kto chce, dalej zaparkuje tu 128 MB na piec
// minut i nie da sie tego odroznic od naszego szyfrogramu bez uwierzytelniania,
// ktorego nie chcemy. Znika konkretna szkoda — klikalna strona pod nasza domena
// i to, co po niej przychodzi: Safe Browsing, po ktorym aplikacja nie otwiera sie
// nikomu. Zostaje przechowalnia na bajty, ktorych nikt nie otworzy ani jako
// strony, ani jako programu.
//
//   node fput.mjs                              # 127.0.0.1:9202 -> rpc.ipfs.encedo.com
//   IPFS_RPC=http://127.0.0.1:5001 node fput.mjs
//
// Zero zaleznosci, jak reszta. Uwaga na jedno: nic tu nie wolno wczytac "w calosci"
// — jeden `await req.text()` albo dowolny gotowy parser multipartu i 128 MB ladu-
// je w pamieci albo na dysku, co jest dokladnie tym, czego ten plik unika.

import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { MAGIC, VERSION, HEADER_LEN } from '../../impl/lib/fileenvelope.ts'
import { insertAfterPartHeaders } from './prefix.mjs'

const PORT = Number(process.env.PORT ?? 9202)
const HOST = process.env.HOST ?? '127.0.0.1'
const RPC = new URL(process.env.IPFS_RPC ?? 'https://rpc.ipfs.encedo.com')
// Katalog-ksiega zamiatacza TTL. Wpis poza nim nigdy nie wygasa (infra/ipfs-ttl.sh).
const DIR = process.env.DIR ?? '/ec'

// Ten sam naglowek, ktory czyta klient. Importowany, nie przepisany: gdyby te
// osiem bajtow zyly w dwoch miejscach, rozjechalyby sie przy pierwszej zmianie.
const HEADER = Buffer.alloc(HEADER_LEN)
Buffer.from(MAGIC).copy(HEADER, 0)
HEADER[4] = VERSION

const log = (...a) => console.log(new Date().toISOString(), ...a)

/** Wystawiony, zeby test mogl podniesc go na porcie efemerycznym. */
export const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    return res.end('{"error":"POST only"}')
  }
  const ct = req.headers['content-type'] ?? ''
  if (!ct.startsWith('multipart/form-data')) {
    res.writeHead(415, { 'content-type': 'application/json' })
    return res.end('{"error":"multipart/form-data expected"}')
  }

  // `pin=false` + wpis w MFS: blob zyje, dopoki nazwa jest w ksiedze, i znika
  // razem z nia. Nazwa musi miec ksztalt `<epoch>-<unikat>`, bo zamiatacz czyta
  // z niej czas — inaczej plik zostaje na zawsze (a nazwy spoza schematu zamia-
  // tacz zostawia w spokoju, wiec bledu nikt by nie zauwazyl).
  const name = `${Date.now()}-${randomBytes(8).toString('hex')}`
  const path = `${RPC.pathname.replace(/\/$/, '')}/api/v0/add` +
    `?pin=false&to-files=${encodeURIComponent(`${DIR}/${name}`)}`

  const send = RPC.protocol === 'https:' ? httpsRequest : httpRequest
  const up = send({
    protocol: RPC.protocol, hostname: RPC.hostname, port: RPC.port, path, method: 'POST',
    headers: {
      'content-type': ct,
      // Bez content-length: prefiks zmienia dlugosc, a Node przejdzie na chunked,
      // ktore Kubo przyjmuje. Podanie starej dlugosci uciela by osiem bajtow.
      'user-agent': 'encedo-proxy',   // Kubo odrzuca UA zaczynajace sie od "Mozilla"
      accept: 'application/json',
    },
    servername: RPC.hostname,
  })

  up.on('response', (r) => {
    res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json' })
    r.pipe(res)
  })
  up.on('error', (e) => {
    log('upstream failed:', e.message)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end('{"error":"store unreachable"}')
  })
  // Klient rozlaczyl sie w polowie 80 MB: nie ma po co dalej wysylac do Kubo.
  req.on('aborted', () => up.destroy())

  pipeline(req, insertAfterPartHeaders(HEADER), up).catch((e) => {
    log('rejected:', e.message)
    up.destroy()
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"malformed upload"}')
    }
  })
})

server.listen(PORT, HOST, () => {
  log(`fput on ${HOST}:${PORT} -> ${RPC.origin} (${DIR}), prefix ${HEADER.toString('hex')}`)
})
