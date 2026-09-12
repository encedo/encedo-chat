// prefix.mjs — wstawienie osmiu bajtow w srodek strumienia multipart.
//
// Klient wysyla `multipart/form-data` z jedna czescia. Zeby doklejenie prefiksu
// nie zniszczylo ramki, trzeba trafic dokladnie za naglowki tej czesci — czyli
// za pierwsze `\r\n\r\n` — i dopiero tam wstawic bajty. Reszta leci bez zmian,
// razem z domykajaca granica.
//
// Wszystko dzieje sie STRUMIENIOWO i to jest cel calego pliku: 128 MB nie moze
// przejsc przez pamiec ani przez dysk. Buforowane sa wylacznie naglowki czesci,
// czyli kilkaset bajtow (`MAX_HEAD` w najgorszym razie) — od momentu wstawienia
// prefiksu kazdy kawalek leci dalej nietkniety.
//
// Nic nie jest przepuszczane, ZANIM prefiks trafi na miejsce. To nie jest
// oszczednosc, tylko warunek: gdyby poczatek ciala poszedl do Kubo wczesniej,
// cialo bez rozpoznawalnych naglowkow czesci zdazyloby sie zapisac w polowie,
// a odmowa przyszlaby po fakcie.

import { Transform } from 'node:stream'

/** Naglowki czesci ponad ten rozmiar to nie jest nasz upload. */
export const MAX_HEAD = 8 * 1024

const SEP = Buffer.from('\r\n\r\n')

/** Transform, ktory wstawia `header` za naglowkami pierwszej czesci multipartu. */
export function insertAfterPartHeaders(header) {
  let head = Buffer.alloc(0)
  let done = false

  return new Transform({
    transform(chunk, _enc, cb) {
      if (done) return cb(null, chunk)

      head = head.length ? Buffer.concat([head, chunk]) : chunk
      const at = head.indexOf(SEP)
      if (at === -1) {
        if (head.length > MAX_HEAD) return cb(new Error('multipart part headers too long'))
        return cb()
      }

      done = true
      const cut = at + SEP.length
      const out = Buffer.concat([head.subarray(0, cut), header, head.subarray(cut)])
      head = Buffer.alloc(0)
      cb(null, out)
    },
    flush(cb) {
      // Strumien skonczyl sie przed naglowkami czesci: cialo nie bylo tym, za co
      // sie podawalo. Lepiej zerwac niz zapisac w magazynie cos bez prefiksu.
      if (!done) return cb(new Error('multipart part headers never ended'))
      cb()
    },
  })
}
