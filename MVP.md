# MVP — plan wydania 0.9

Co trzeba **zrobić**, co trzeba **przetestować** i co trzeba **podpisać**, żeby
wypuścić onchato 0.9 na cztery cele: **web, desktop, Android, iOS**.

Nazwa pliku: `MVP.md`, nie `MCP.md` — w tym repo `MCP` znaczyłoby co innego
(Model Context Protocol), a to jest plan wydania.

> Stan wyjściowy: **0.3.6**. `npm test` 334/334, `browser-test` PASS, CI zielone,
> tag `v0.3.4` udowodnił ścieżkę wydania (desktop + Android z jednego tagu).

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
| podpisany | n/d | ❌ | ❌ | ❌ (świadomie) | ❌ |
| 1:1 + grupy | ✅ | ✅ | ❓ | ❓ | ❌ |
| WebRTC direct | ✅ | ❌ **brak w WebKitGTK** | ❓ | ❓ | ❓ |
| powiadomienia | ✅ | ✅ (0.3.4) | ❓ | ❌ etap C | ❓ |
| zasobnik / tło | n/d | ⚠️ zależy od pulpitu | ❓ | ❌ etap C | ❓ |
| głosówki | ✅ | ❓ niepotwierdzone | ❓ | ❓ | ❓ |
| skaner QR | ❌ (brak API) | ❌ | ✅ powinien | ✅ powinien | ✅ |

❓ = **zbudowane, ale nikt tego nie uruchomił**. To jest największa dziura w tym
projekcie: mamy pięć celów i dowody z dwóch.

---

## 3. Blokery — bez tego nie ma 0.9

### B1. Nikt nie uruchomił Windows, macOS ani Androida
Artefakty z Actions istnieją i **nigdy nie zostały zainstalowane**. Zanim
cokolwiek podpiszemy, trzeba przejść ścieżkę z §6 na każdej z tych platform.
Najtańsze najpierw: **Android**, bo APK da się wgrać w minutę
([[android-build-machine]] — buduje się tylko na maszynie x86_64).

### B2. Android nie przeżywa uśpienia (etap C)
Bez foreground service system zamraża proces i wiadomość nie dochodzi. Dla
produktu **bez store-and-forward** to nie jest niedogodność, tylko brak funkcji:
telefon w kieszeni = osoba nieosiągalna. **To jest największa robota w tym
planie** i jedyna, która może przesunąć termin.

### B3. Migracja profilu software
Dziś wyczyszczenie danych przeglądarki kasuje **tożsamość**, nie tylko kontakty
— a klucz jest losowy, więc ta sama nazwa i hasło dają **inny** klucz i wszyscy
rozmówcy mają zapisany stary. Uzgodniony zakres: eksport **całości** profilu
(tożsamość + kontakty + grupy + ustawienia), import w oknie logowania, kolizja
nazwy = głośna odmowa, ekran mówi „przenosisz", nie „skopiowano".

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

### B6. Kłamstwa w kodzie i w UI
- Komentarze w `lib/capabilities.ts` i `web/src/app.ts` twierdzą, że skorupka
  włączyła WebRTC. **Nieprawda** — `enable-webrtc` nie pomogło, WebKitGTK w tej
  paczce nie ma `RTCPeerConnection`.
- Okno usuwania kontaktu miesza języki: angielski UI kończy zdaniem
  „Historia rozmowy i tak nie jest przechowywana."

---

## 4. Do zrobienia — lista robocza

Kolejność jest kolejnością ryzyka: najpierw to, co może wywrócić plan.

1. **Android etap C** — foreground service, ikona w pasku stanu, wznowienie po
   powrocie na pierwszy plan (połowa już jest: `visibilitychange` → `refresh()`).
2. **Migracja profilu** (B3).
4. **Podpisywanie Windows** — Azure Sign Tool w Actions, jak w `encedo-wg-hsm`
   (§5).
5. **Poprawki z B6** + przegląd katalogu i18n pod kątem innych gołych stringów.
6. **iOS** — dopiero po założeniu Apple ID: `tauri ios init`, budowa, wgranie na
   urządzenie. Ikony i `identifier` (`com.onchato.chat`) są już gotowe.
7. **Test grupy 4–5 osób na żywo** — najstarszy niespłacony dług.
8. **Flaki do obserwacji**: przeładowanie grupy w pełnym `browser-test`,
   scenariusz wzmianek. Jeśli wrócą w CI, złapać log, nie „puścić jeszcze raz".

---

## 5. Podpisywanie i dystrybucja

| cel | jak | stan |
|---|---|---|
| **Windows** | **Azure Sign Tool** w Actions, wzorzec z `encedo-wg-hsm`: certyfikat w Azure Key Vault, `AZURE_*` w secrets repo, podpis `.msi`/`.exe` po `tauri build` | do zrobienia |
| **macOS** | niepodpisane — instalacja przez „Otwórz mimo to". Podpis = subskrypcja Apple Developer; decyzja przy iOS | świadomie odłożone |
| **Linux** | `.deb` + `.rpm` + AppImage bez podpisu; dystrybucja z GitHub Releases | działa |
| **Android** | CI produkuje **niepodpisany** `.aab`/`.apk`; podpis kluczem upload na maszynie, która trzyma keystore, potem Play App Signing | zgodne z zaleceniem Google, do przejścia raz |
| **iOS** | wymaga konta Apple; TestFlight na start | zablokowane kontem |

**Aktualizacje automatyczne (Tauri updater): decyzja do podjęcia.** Dziś nie ma
klucza podpisu updatera, więc paczki się nie aktualizują same. Dla produktu bez
serwera to spójne, ale znaczy, że **każda poprawka bezpieczeństwa wymaga, żeby
człowiek pobrał nową paczkę**. Do rozstrzygnięcia przed 0.9, nie po.

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
13. **Diagnostyka**: raport możliwości i test WebRTC mówią prawdę o platformie.

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

---

## 7. Świadomie poza 0.9

Zapisane, żeby nie wracały jako „a może jeszcze": wielourządzeniowość, OIDC i
rejestracja urządzenia, historia po restarcie (sync od członka **odrzucony** —
obchodzi lockout epok), rozmowy głosowe/wideo (osobny projekt, osadzenie
później), telemetria (**zdecydowane: nie ma**), płaszczyzna relay-blind (§13,
czeka na gossipsub v3), TURN (**zdecydowane: nie**).

---

## 8. Kolejność

1. **Teraz**: przejść §6.1 na Androidzie z artefaktu — to jedno pokaże, czy B2
   jest tygodniem roboty, czy dwoma dniami.
2. Równolegle: migracja profilu (B3) i `PROTOCOL.md` (B5) — obie niezależne od
   platform.
3. Potem: Windows z podpisem (§5) i przejście §6.1 na Windows i macOS.
4. `bs2` do porządku (B4).
5. Na końcu: iOS, jeśli konto będzie; jeśli nie — 0.9 wychodzi bez iOS i to jest
   w porządku, byle **strona z pobieraniem nie obiecywała iOS**.

**Wersje po drodze**: numer rośnie z każdą paczką (0.3.x). Tag `v0.9.0`
odpalamy dopiero, gdy §6.1 przeszło na web, desktop i Androidzie.
