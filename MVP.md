# MVP — plan wydania 0.9

Co trzeba **zrobić**, co trzeba **przetestować** i co trzeba **podpisać**, żeby
wypuścić onchato 0.9 na cztery cele: **web, desktop, Android, iOS**.

Nazwa pliku: `MVP.md`, nie `MCP.md` — w tym repo `MCP` znaczyłoby co innego
(Model Context Protocol), a to jest plan wydania.

> Stan na 2026-08-30: **0.5.10**. `npm test` 378/378, `browser-test` PASS, CI
> zielone. Ścieżka wydania sprawdzona wielokrotnie (ostatni tag `v0.5.9`
> zbudował desktop + **podpisany** APK z jednego tagu; web wdraża się sam
> timerem systemd po tagu).

---

## 1. Co 0.9 ma znaczyć

**0.9 = pierwsza wersja, którą można dać obcej osobie bez instrukcji obsługi i
bez asysty.** To jest jedyne kryterium, które trzyma resztę tego dokumentu:

- instaluje się z podpisanego pakietu na swojej platformie,
- da się nią rozmawiać z drugą osobą **bez pomocy trzeciej**,
- kiedy czegoś nie umie (WebRTC na desktopie, skaner QR na Linuksie), **mówi to
  wprost** zamiast milczeć albo udawać,
- utrata danych jest **odwracalna albo zapowiedziana** — nigdy cicha.

Czego 0.9 **nie** musi mieć: wielourządzeniowości, historii po restarcie,
rozmów głosowych na żywo, sklepów aplikacji (poza Play, jeśli zdążymy), OIDC.

---

## 2. Stan na dziś, uczciwie, per cel

| | web | desktop (Linux) | desktop (Win/macOS) | Android | iOS |
|---|---|---|---|---|---|
| buduje się | ✅ | ✅ | ✅ w Actions | ✅ w Actions | ❌ nie próbowane |
| podpisany | n/d | ❌ (updater: minisign) | ❌ | ✅ **APK, klucz dev z sekretów** / `.aab` świadomie nie (Play App Signing) | ❌ |
| 1:1 + grupy | ✅ | ✅ | ❓ | ✅ | ❌ |
| WebRTC direct | ✅ | ❌ **brak w WebKitGTK** | ❓ | ❓ (webview ma API, most `wry` niesprawdzony) | ❓ |
| powiadomienia | ✅ | ✅ | ❓ | ✅ | ❓ |
| zasobnik / tło | n/d | ⚠️ zależy od pulpitu | ❓ | ✅ **foreground service, potwierdzony na urządzeniu** | ❓ |
| głosówki | ✅ | ✅ (winne było audio VM, nie kod) | ❓ | ❓ | ❓ |
| skaner QR | ❌ (brak API) | ❌ | ✅ powinien | ✅ powinien | ✅ |

❓ = **zbudowane, ale nikt tego nie uruchomił**. Dowody są z trzech celów (web,
desktop-Linux, Android); Windows, macOS i iOS wciąż bez ani jednego uruchomienia.

---

## 3. Blokery — bez tego nie ma 0.9

### B1. Nikt nie uruchomił Windows ani macOS
Artefakty z Actions istnieją i **nigdy nie zostały zainstalowane**. Zanim
cokolwiek podpiszemy, trzeba przejść ścieżkę z §6 na obu platformach.
(Android wypadł z tej listy 2026-08: podpisany APK z Actions zainstalowany,
ścieżka §6.1 przechodzona na urządzeniu.)

### B2. ~~Android nie przeżywa uśpienia~~ — ✅ ZROBIONE
Foreground service (`OnchatoService.kt`, typ `specialUse`, wstrzykiwany przez
`patch.mjs`); **doręczanie w tle potwierdzone na urządzeniu**. Do każdego
wydania zostaje test regresyjny z §6.2: ekran wygaszony 10 minut, wiadomość
dochodzi.

### B3. ~~Migracja profilu software~~ — ✅ ZROBIONE
`lib/migrate.ts` + import na karcie logowania, dokładnie w uzgodnionym zakresie:
eksport **całości** profilu w jednym zapieczętowanym pliku (nazwa W ŚRODKU
pieczęci), hasło = hasło profilu, kolizja nazwy = głośna odmowa, słownictwo
„przenosisz". Testy `test/migrate.test.ts` + scenariusz w `browser-test`.

### B4. Trzeci węzeł rendezvous
**Sprostowanie:** `bs2` jest zdrowy — przeszedł cały scenariusz grupowy
`browser-test` puszczony wyłącznie na nim. Wcześniejsze „bs2 leży" było **moim
błędem obsługi**: `RELAY_NODE` bierze pełny multiaddr, a ja podałem nazwę hosta,
która wylądowała w liście węzłów jako nieprawidłowy adres.

Zostaje realne ryzyko: **dwa węzły to dwa punkty awarii, a nie zapas**. Przed
0.9 warto mieć `bs3` — PeerId jest już wyliczony i zapisany w `relay/README.md`,
więc robota to VM, DNS, nginx i `--pass bs3.onchato.com`. Do `infra/nodes.json`
dopisujemy go **dopiero gdy odpowiada**.

### B5. Specyfikacje zgodne z kodem — ✅ ZROBIONE
`re` i `edit` **były już** opisane w §7.4 (to notatka w `CLAUDE.md` była
nieaktualna i mnie zmyliła — poprawiona). Porównanie typów kopert z kodem
znalazło jedną prawdziwą lukę: **`rtc`**, koperta sygnalizacji WebRTC, jeździła
po drucie i nie było jej w specyfikacji. Dopisana. Lista typów w §7.4 zgadza się
teraz z `lib/envelope.ts` co do nazwy, `group-skd`/`group-skd-req` włącznie.

### B6. ~~Kłamstwa w kodzie i w UI~~ — ✅ ZROBIONE (`69fc2b9`)
Komentarze o WebRTC mówią teraz odwrotnie i zgodnie z pomiarem („włączone —
i nic nie zmieniło"); okno usuwania kontaktu przeszło przez `tr()` z wpisem
w katalogu. Strażnik `test/i18n.test.ts` czyta od 0.5.8 miejsca wywołań, więc
goły string na ścieżce UI wywala build.

---

## 4. Do zrobienia — lista robocza

Kolejność jest kolejnością ryzyka: najpierw to, co może wywrócić plan.

1. ~~Android etap C~~ — ✅ (B2).
2. ~~Migracja profilu~~ — ✅ (B3).
3. **Podpisywanie Windows** — kod w `desktop.yml` już jest i włączy się sam po
   ustawieniu sześciu zmiennych repozytorium (§5). Realny bloker: **nie ma
   jeszcze tenanta Azure**, a walidacja tożsamości organizacji to najdłuższy
   element.
4. ~~Poprawki z B6~~ — ✅.
5. **iOS** — dopiero po założeniu Apple ID: `npm run tauri -- ios init`, budowa,
   wgranie na urządzenie. Ikony i `identifier` (`com.onchato.chat`) są gotowe.
6. **Test grupy 4–5 osób na żywo** — najstarszy niespłacony dług.
7. **Flaki do obserwacji**: przeładowanie grupy w pełnym `browser-test`,
   scenariusz wzmianek. Jeśli wrócą w CI, złapać log, nie „puścić jeszcze raz".
8. **Strona pobierania** — nie istnieje żadna (landing linkuje tylko `/chat`,
   GitHub i dokumenty); przed 0.9 musi powstać i **nie obiecywać iOS**.

---

## 5. Podpisywanie i dystrybucja

| cel | jak | stan |
|---|---|---|
| **Windows** | **Azure Trusted Signing przez OIDC**, wzorzec z `encedo-wg-hsm` — **bez sekretów**, sterowane zmiennymi repo (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE`). Podpis oddany Tauri przez `signCommand`, żeby podpisany był też **luźny `.exe`**, nie tylko instalatory | **przygotowane, nieuruchomione** — włączy się samo, gdy ustawisz zmienne |
| **macOS** | niepodpisane — instalacja przez „Otwórz mimo to". Podpis = subskrypcja Apple Developer; decyzja przy iOS | świadomie odłożone |
| **Linux** | `.deb` + `.rpm` + AppImage bez podpisu; dystrybucja z GitHub Releases | działa |
| **Android** | CI podpisuje **APK** kluczem deweloperskim z sekretów (`zipalign` + `apksigner` v2/v3 + `verify`; brak sekretów = job failuje z listą nazw); `.aab` celowo niepodpisany pod Play App Signing; dwa osobne artefakty | ✅ działa, APK zainstalowany z Actions |
| **updater desktopu** | minisign (`tauri signer`), klucz prywatny w sekretach (`TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`), pubkey w `tauri.conf.json`; `latest.json` w draft release | ✅ kod działa; patrz bramka niżej |
| **web** | auto-deploy: host sam robi pull+build po tagu (`infra/deploy-on-tag.sh` + timer systemd; model PULL — żaden klucz produkcji nie leży w runnerze); relay celowo NIE jest restartowany | ✅ działa |
| **iOS** | wymaga konta Apple; TestFlight na start | zablokowane kontem |

**Aktualizacje automatyczne — zbudowane (0.4.0); rządzą nimi dwa fakty.**
(a) **Draft release jest bramką**: tag buduje `latest.json`, ale assety drafta
nie są publiczne, więc do kliknięcia „Publish release" updater dostaje 404 —
celowo, publikacja = wydanie. Po każdym tagu sprawdzić, czy draft w ogóle ma
`latest.json` (bez sekretów podpisu build przechodzi na zielono i po cichu go
nie tworzy). (b) `desk_update_kind` = `system` dla `.deb`/`.rpm` — paczki
dystrybucyjne dostają **powiadomienie + link**, nigdy podmianę; samo-aktualizacja
dotyczy AppImage/Windows/macOS. Test podmiany ma sens tylko na Win/macOS
(AppImage nie startuje na VM bez 3D — EGL_BAD_PARAMETER).

---

## 6. Testy — ta sama ścieżka na każdej platformie

Skrypt jest jeden, bo pytanie jest jedno: *czy dwie obce osoby się dogadają*.
Przejście = wszystkie punkty na danej platformie, **na paczce z Actions**, nie
na buildzie z laptopa.

### 6.1 Ścieżka główna (każdy cel)
1. Instalacja z artefaktu wydania. Aplikacja startuje, pokazuje ikonę i wersję.
2. Założenie tożsamości: HEM **oraz** profil software z hasłem.
3. Dodanie kontaktu: link zaproszenia **i** kod QR (tam, gdzie jest kamera).
4. Rozmowa 1:1: tekst, emoji, odpowiedź (↩), poprawka (✏), reakcja.
5. Plik: wysłanie, odebranie, wygaśnięcie po kilku minutach.
6. Obraz: wklejenie ze schowka, podgląd u nadawcy od razu, „Pokaż" u odbiorcy.
7. Głosówka: nagranie, wysłanie, odsłuch po drugiej stronie.
8. Grupa: założenie, zaproszenie, broadcast, wzmianka `@`, usunięcie członka
   (usunięty przestaje widzieć), dodanie z powrotem.
9. Przypięcie wiadomości i jej powrót po restarcie aplikacji.
10. Zerwanie sieci na 30 s: ⚠ przy wiadomości, ↻ dowozi ją po powrocie.
11. Powiadomienie, gdy okno nie jest na wierzchu; **treść wiadomości nigdy w banerze**.
12. Wylogowanie i ponowne wejście: kontakty i grupy są, transkrypcja nie.
13. **Diagnostyka**: raport możliwości i test WebRTC mówią prawdę o platformie
    — **schowane za `?debug=1`** (decyzja z 0.3.x), więc krok wymaga wejścia
    z tym parametrem.

### 6.2 Dodatkowo per cel
- **web**: Chromium i Firefox; telefon w pionie i w poziomie; klawiatura
  ekranowa nie zasłania pola; odświeżenie strony w trakcie rozmowy.
- **desktop**: zamknięcie okna (zasobnik **albo** wyjście — zależnie od pulpitu),
  drugie uruchomienie podnosi istniejące okno, autostart po restarcie systemu,
  przeciągnięcie pliku na okno.
- **Android**: **ekran wygaszony 10 minut → wiadomość dochodzi** (to jest test
  etapu C, nie formalność), obrót ekranu, powrót z tła, udostępnianie pliku do
  aplikacji.
- **iOS**: to samo co Android, gdy będzie konto.

### 6.3 Test bezpieczeństwa, który musi przejść przed wydaniem
1. Blob w magazynie plików **nie zawiera** tekstu jawnego (harness to sprawdza,
   powtórzyć ręcznie na produkcji).
2. Powiadomienie nie niesie treści w żadnym z trzech trybów.
3. Usunięcie kontaktu odcina osiągalność (druga strona przestaje docierać).
4. Usunięcie z grupy: usunięty **nie** odczytuje wiadomości po rotacji epoki.
5. Wipeout kasuje wszystkie klucze `ec-*` i wraca do logowania.
6. Druga karta z tą samą tożsamością: obie sesje stają, komunikat to tłumaczy.
7. **Podmiana `pub` w książce kontaktów jest wykrywana przy logowaniu**
   (`lib/bookmac.ts`: `tampered` = książka nieużywana i NIEnadpisywana — dowód
   zostaje). To dziś jedyna obrona trust anchora i nikt jej ręcznie nie
   przechodzi.

---

## 7. Świadomie poza 0.9

Zapisane, żeby nie wracały jako „a może jeszcze": wielourządzeniowość, OIDC i
rejestracja urządzenia, historia po restarcie (sync od członka **odrzucony** —
obchodzi lockout epok), rozmowy głosowe/wideo (osobny projekt, osadzenie
później), telemetria (**zdecydowane: nie ma**), płaszczyzna relay-blind (§13,
czeka na gossipsub v3), TURN (**zdecydowane: nie**).

---

## 8. Kolejność (stan 2026-08-30)

1. ~~§6.1 na Androidzie z artefaktu~~ — ✅ przechodzone, etap C potwierdzony.
2. ~~Migracja profilu i `PROTOCOL.md`~~ — ✅ obie.
3. **Teraz**: Windows z podpisem (§5 — czeka na tenant Azure) i przejście §6.1
   na Windows i macOS; opublikować draft release i przetestować podmianę
   updatera na jednej z tych platform.
4. `bs3` (B4) — VM, DNS, nginx, `--pass`; PeerId już wyliczony.
5. Na końcu: iOS, jeśli konto będzie; jeśli nie — 0.9 wychodzi bez iOS i to jest
   w porządku, byle **strona z pobieraniem nie obiecywała iOS** (a strony
   jeszcze nie ma — §4 pkt 8).

**Wersje po drodze**: numer rośnie z każdą paczką (0.5.x). Tag `v0.9.0`
odpalamy dopiero, gdy §6.1 przeszło na web, desktop i Androidzie.
