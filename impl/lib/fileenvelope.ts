/**
 * fileenvelope.ts — osiem bajtow przed szyfrogramem, zeby magazyn mial ksztalt.
 *
 * `POST /f` jest otwarty dla swiata z rozmyslu (uwierzytelniony upload wiedzialby,
 * KTO wyslal CO i KIEDY — dokladnie te metadane, ktorych produkt unika). Cena jest
 * taka, ze pod naszym adresem moze wisiec cudza tresc: sprawdzone 2026-09-12, plik
 * HTML wgrany curl-em wraca z bramki jako `text/html`.
 *
 * **Dokleja go serwis (`infra/fput/`), nie klient** — i to jest cala mechanika. Gdyby
 * doklejal klient, napastnik po prostu by tego nie zrobil; gdy dokleja serwis, prefiks
 * dostaje KAZDY upload, lacznie z cudzym. Nikt go po drodze nie zdejmuje, ani `/f`, ani
 * bramka, wiec **co wchodzi, nie jest tym, co wychodzi**: magazyn przestaje oddawac
 * cokolwiek 1:1, a Kubo — ktore typuje tresc po pierwszych bajtach — odpowiada
 * `application/octet-stream` zamiast `text/html`. Ochrona przestaje zalezec od naglowkow
 * HTTP, ktore trzeba pamietac przy kazdym nowym miejscu serwowania.
 *
 * Czego NIE robi: nie odmawia i nie uwierzytelnia. Kto zna nasz format, dalej zaparkuje
 * tu 128 MB na piec minut. Roznica jest taka, ze to, co pobierze ofiara, nie jest ani
 * dzialajaca strona, ani dzialajacym plikiem wykonywalnym. To filtr strukturalny, nie
 * tozsamosciowy — a uwierzytelniony upload wiedzialby, kto co wyslal i kiedy.
 *
 * **Prefiks jest STALY** (decyzja uzytkownika): gdyby zalezal od wersji czy commita,
 * plik wyslany z 0.5.73 nie otworzylby sie w 0.5.74. Bajt wersji istnieje po to, zeby
 * zmienic format swiadomie, a nie przy kazdym wydaniu.
 *
 * Co tu NIE trafia: lista wezlow po CID. To tresc opublikowana i przypieta, nie upload,
 * i weryfikuje ja `cid.ts`. Dlatego koperta zyje przy sciezce plikowej w `app.ts`,
 * a nie w `net/ipfs.ts`, ktory zostaje transportem i niczym wiecej.
 */

/** 'ECF1' — cztery bajty, po ktorych straznik poznaje nasz upload. */
export const MAGIC = Uint8Array.from([0x45, 0x43, 0x46, 0x31])
/** Wersja formatu koperty. Zmienia sie tylko wtedy, gdy zmienia sie uklad bajtow. */
export const VERSION = 1
/** Magic (4) + wersja (1) + trzy bajty zapasu. Osiem, zeby szyfrogram zostal wyrownany. */
export const HEADER_LEN = 8

/**
 * Szyfrogram w kopercie. Kopiuje raz — wolacy i tak trzyma oryginal do wyslania.
 *
 * Klient tego NIE wola: prefiks dokleja `infra/fput/` w locie, zeby dostal go rowniez
 * upload, ktory nie przyszedl z naszej aplikacji. Zostaje tu jako definicja formatu —
 * z niej bierze naglowek serwis i przeciw niej pisane sa testy.
 */
export function wrapBlob(cipher: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + cipher.length)
  out.set(MAGIC, 0)
  out[4] = VERSION
  out.set(cipher, HEADER_LEN)
  return out
}

/** Czy te bajty zaczynaja sie nasza koperta. */
export function hasEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LEN) return false
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false
  return true
}

/**
 * Zdejmij koperte, jesli jest.
 *
 * **Tolerancyjny z rozmyslu.** Blob bez naglowka to plik, ktory trafil do magazynu
 * zanim serwis stanal, albo przez instalacje, ktora go nie ma (`--network`, dev z
 * lokalnym Kubo). Zaden z tych przypadkow nie jest podejrzany, a odmowa kosztowalaby
 * czyjs plik.
 *
 * Znany magic z NIEZNANA wersja to inna sprawa: to format z nowszego builda, ktorego
 * nie umiemy przeczytac. Lepiej powiedziec to wprost niz probowac odszyfrowac bajty
 * ulozone inaczej i zglosic "plik uszkodzony".
 */
export function unwrapBlob(bytes: Uint8Array): Uint8Array {
  if (!hasEnvelope(bytes)) return bytes
  const v = bytes[4]
  if (v !== VERSION) throw new Error(`file envelope version ${v} — this build reads ${VERSION}`)
  return bytes.subarray(HEADER_LEN)
}
