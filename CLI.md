# onchato w terminalu — podręcznik

`onchato` to klient onchato w terminalu: ta sama sieć, to samo szyfrowanie i te
same tożsamości co aplikacja. Rozmawiasz z każdym, kto używa aplikacji,
z okna terminala, przez SSH albo wewnątrz `screen`/`tmux`. Interfejs jest
wzorowany na irssi: każda rozmowa ma swoje okno, a pasek stanu na dole pokazuje,
gdzie coś się dzieje.

Ten podręcznik opisuje stan z 2026-10-07. Plan dalszych etapów (tryb skryptowy,
demon, powiadomienia, pliki, grupy) jest w [CLI-PLAN.md](CLI-PLAN.md).

---

## Spis treści

1. [Instalacja](#1-instalacja)
2. [Pierwsze kroki](#2-pierwsze-kroki)
3. [Tożsamość: profil albo HEM](#3-tożsamość-profil-albo-hem)
4. [Kontakty](#4-kontakty)
5. [Zaproszenia, które odpowiadają same](#5-zaproszenia-które-odpowiadają-same)
6. [Weryfikacja: numer bezpieczeństwa](#6-weryfikacja-numer-bezpieczeństwa)
7. [Klient rozmów](#7-klient-rozmów)
8. [Skrypty i demon](#8-skrypty-i-demon)
9. [Spis komend](#9-spis-komend)
10. [Opcje i zmienne środowiskowe](#10-opcje-i-zmienne-środowiskowe)
11. [Gdzie są dane i jak są chronione](#11-gdzie-są-dane-i-jak-są-chronione)
12. [Ograniczenia, które warto znać](#12-ograniczenia-które-warto-znać)
13. [Rozwiązywanie problemów](#13-rozwiązywanie-problemów)

---

## 1. Instalacja

Wymagany **Node.js 24** lub nowszy (uruchamia kod TypeScript bezpośrednio).

Na razie `onchato` uruchamia się z repozytorium. Najwygodniej podlinkować je jako
zwykłą komendę:

```sh
mkdir -p ~/.local/bin
ln -s <repo>/impl/cli/onchato.ts ~/.local/bin/onchato
onchato            # bez argumentów: krótka ściągawka
```

`~/.local/bin` jest w `PATH` na większości dystrybucji (po ponownym zalogowaniu).
Dowiązanie wskazuje na repozytorium, więc `git pull` od razu daje nową wersję.

Paczka `npm install -g onchato` i obraz Docker są zaplanowane (etap 7).

---

## 2. Pierwsze kroki

Pięć minut od zera do rozmowy z kimś, kto ma aplikację:

```sh
onchato profile new ala                      # 1. tożsamość (hasło, dwa razy)
onchato invite --qr                          # 2. Twój kod - druga osoba skanuje go w aplikacji
onchato add 'https://app.onchato.com/#i=…'   # 3. albo dodajesz jej link (pokaże odcisk, zapyta)
onchato verify ewa                           # 4. porównajcie numer bezpieczeństwa
onchato chat                                 # 5. klient: lista kontaktów, /query 1, piszesz
```

Rozmowa zaczyna się dopiero wtedy, gdy **obie strony mają nawzajem swoje klucze**.
Z tego biorą się trzy sposoby dodawania kontaktu opisane w rozdziale 4.

---

## 3. Tożsamość: profil albo HEM

### Profil programowy

Para kluczy wygenerowana na tym komputerze, zapieczętowana hasłem — ten sam
format co profil w aplikacji.

```sh
onchato profile new <nazwa>      # hasło podajesz dwa razy
onchato profile list
```

Hasło musi być mocne (pełny miernik, około 60 bitów) — ta sama zasada co
w aplikacji. Najprościej: dwa, trzy zwykłe słowa (`kot pies dom lampa`).
**Profilu nie da się odzyskać** — bez hasła nie ma do niego drogi.

### Przeniesienie profilu z aplikacji i z powrotem

```sh
onchato profile import ala.ocmig             # plik z aplikacji: Ustawienia → Przenieś profil
onchato profile export ala ala.ocmig         # i odwrotnie
```

Przenoszone są tożsamość, kontakty, zaproszenia i lista węzłów. To jest
**przeniesienie, nie kopia**: ta sama tożsamość otwarta w dwóch miejscach naraz
zamyka obie sesje (zob. rozdział 12).

### HEM

Klucz siedzi w urządzeniu i go nie opuszcza. Do każdej komendy dodajesz `--hem <url>`:

```sh
onchato whoami --hem https://my.ence.do
onchato chat --hem https://my.ence.do
```

- Jeśli HEM ma **kilka tożsamości**, `onchato` wyświetli ponumerowaną listę i zapyta,
  której użyć. `--handle <nazwa>` wybiera bez pytania.
- Logowanie **nigdy nie tworzy** tożsamości. Nową tworzysz świadomie:

  ```sh
  onchato hem new <nazwa> --hem https://my.ence.do
  ```

- Kontakty zapisane w HEM pojawiają się razem z lokalnymi (`onchato contacts`
  pokazuje źródło: `hem` albo `local`).

### Który profil

Bez `--profile` i bez `--hem` `onchato` używa jedynego profilu, jaki jest. Gdy jest
ich kilka, wybierasz `--profile <nazwa>`.

---

## 4. Kontakty

```sh
onchato contacts                 # nazwa, odcisk klucza, źródło
```

Trzy sposoby dodania kontaktu:

| sposób | jak | co dalej |
|---|---|---|
| **link tożsamości** | `onchato add '<link>'` (link z aplikacji: „Udostępnij swój profil”) | `onchato` wypisze **link zwrotny** — odeślij go tej osobie, żeby miała też Twój klucz |
| **Twój kod QR** | `onchato invite --qr`, druga osoba skanuje go w aplikacji | ona dodaje Ciebie; Ty dodajesz ją jej linkiem zwrotnym |
| **zaproszenie ze skrzynką** | rozdział 5 | puka i po `/accept` macie się nawzajem — bez odsyłania linków |

`add` przyjmuje link w każdej postaci: cały adres, sam fragment `#i=…` albo goły
kod. Pokazuje **nazwę i odcisk klucza** i pyta `t/N` — porównaj odcisk z tym, co ta
osoba podała Ci innym kanałem (rozmowa, telefon). W skrypcie: `--yes`.

```sh
onchato add '<link>' --name "Ewa z biura"    # własna nazwa zamiast tej z linku
onchato add ewa <kluczB64>                   # surowy klucz publiczny (32 bajty, base64)
```

Nazwa w linku to tylko deklaracja — o tożsamości decyduje klucz.

---

## 5. Zaproszenia, które odpowiadają same

Zaproszenie ze skrzynką to link (i kod QR), który możesz powiesić gdziekolwiek.
Kto je otworzy, **puka** swoim kluczem; Ty widzisz pukanie z odciskiem i decydujesz.
Po przyjęciu macie się nawzajem w kontaktach.

```sh
onchato invites new biuro --expires 24h --qr   # nowe zaproszenie (czas: 30m, 24h, 7d; bez --expires - bez terminu)
onchato invites                                # lista z linkami
onchato invites qr 1                           # kod QR zaproszenia nr 1
onchato invites revoke 1                       # wycofanie - nikt o tym nie jest informowany
```

**Pukanie widać w kliencie** (`onchato chat`) — zaproszenie „słucha” tylko wtedy,
gdy klient działa:

```
23:04 -!- Ewa puka (zaproszenie „biuro”) · odcisk 71:84:64:2F:8E:66:01:E7 - /accept 1 · /ignore 1
```

| w kliencie | działanie |
|---|---|
| `/knocks` | lista oczekujących pukań |
| `/accept N` | dodaje tę osobę do kontaktów |
| `/ignore N` | ignoruje ten klucz — kolejne pukanie z niego się nie pojawi |

Przyjęcie jest zawsze ręczne. Zaproszenie jest publiczne i żyje, dopóki go nie
wycofasz — zapukać może każdy, kto kiedykolwiek widział ten kod.

**W drugą stronę:** `onchato add '<link zaproszenia>'` dodaje kontakt i puka.
Jeśli zapraszający jest akurat offline, klient (`onchato chat`) puka dalej co 90 s,
aż przyjmie — wtedy zobaczysz „… przyjął(a) Twoje pukanie”.

Zaproszenia przenoszą się razem z profilem między aplikacją a terminalem.

---

## 6. Weryfikacja: numer bezpieczeństwa

```sh
onchato verify ewa               # 60 cyfr, u obojga identyczne
onchato verify ewa --qr          # to samo jako kod QR
onchato verify ewa 38421 99404 … # porównanie z numerem przeczytanym przez drugą osobę
```

Porównajcie numer osobiście albo przez telefon (w aplikacji jest w oknie pod 🔐,
tam można też zeskanować kod QR). Zgodny numer znaczy, że nikt nie podszywa się pod
żadne z Was. Przy porównaniu `verify` kończy się kodem `0` (zgodny) albo `4`
(niezgodny) — przydatne w skryptach.

---

## 7. Klient rozmów

```sh
onchato chat               # start od listy kontaktów
onchato chat ewa           # od razu z otwartą rozmową z ewa
```

Klient wymaga prawdziwego terminala. Zajmuje cały ekran (jak irssi czy `less`)
i po wyjściu przywraca terminal do poprzedniego stanu.

### Ekran

```
22:39 <ewa> cześć, testujesz CLI?             ← okno: bieżąca rozmowa
22:39 <ala> tak, z terminala przez ssh
22:41 -!- plik od ewa: raport.pdf (1.2 MB)     ← -!- to komunikaty systemowe
[22:42] [ala·HEM] [bs1 ●] [2:ewa 🔐] [Act: 3,4]  ← pasek stanu
[ewa] tu piszesz▌                              ← linia wpisywania
```

Pasek stanu:

| pole | znaczenie |
|---|---|
| `[22:42]` | godzina |
| `[ala·HEM]` | Twoja tożsamość i jej rodzaj (`HEM` / `software`) |
| `[bs1 ●]` | węzeł i połączenie: zielone ● połączono, czerwone ● brak, żółte ○ łączę |
| `[2:ewa 🔐]` | bieżące okno; 🔐 = sesja zabezpieczona (uzgodnienie klucza EH-2 zakończone) |
| `[Act: 3,4]` | okna z nowymi wiadomościami; na fioletowo — wzmianka o Tobie |

### Okna

- Okno **1** to status: start, połączenie, lista kontaktów, pukanie do zaproszeń.
- Każda rozmowa dostaje kolejny wolny numer i zachowuje go, dopóki jej nie zamkniesz.
- Gdy ktoś zacznie z Tobą rozmowę, jego okno otwiera się **w tle**: w statusie pojawia
  się informacja, a na pasku `Act:` — Twój widok się nie przesuwa.

### Klawisze

| klawisz | działanie |
|---|---|
| **Alt+1 … Alt+9** | przełącz okno (Alt+0 = okno 10) |
| **Tab** | po `/query ` — dopełnij nazwę kontaktu |
| **Enter** | wyślij wiadomość albo wykonaj polecenie |
| **← →**, **Home** / **End**, **Ctrl+A** / **Ctrl+E** | ruch w linii |
| **Backspace**, **Delete** | kasowanie |
| **Ctrl+W** | skasuj słowo przed kursorem |
| **Ctrl+U** | skasuj do początku linii |
| **↑ ↓** | historia wpisanych linii |
| **Ctrl+L** | przerysuj ekran |
| **Ctrl+C**, **Ctrl+D** | wyjście (jak `/quit`) |

### Polecenia

| polecenie | działanie |
|---|---|
| `/list` | kontakty z obecnością (● online, ○ offline), ponumerowane |
| `/query <nr>` · `/query <nazwa>` · `/q …` | otwórz rozmowę (w nowym albo istniejącym oknie) |
| `/win <nr>` · `/w <nr>` | przełącz okno |
| `/close` | zamknij bieżącą rozmowę |
| `/who` | czy rozmówca jest teraz w pokoju |
| `/me <akcja>` | akcja („* ala macha”) |
| `/react <emoji>` | reakcja na ostatnią wiadomość rozmówcy |
| `/verify` | numer bezpieczeństwa tej rozmowy |
| `/invite` | Twój link tożsamości |
| `/knocks` · `/accept N` · `/ignore N` | pukanie do Twoich zaproszeń (rozdział 5) |
| `/clear` | wyczyść bieżące okno |
| `/help` | ściągawka |
| `/quit` · `/exit` | wyjdź (rozmówcy dostają informację o wyjściu) |

Linie wykonują się po kolei — wiadomość wpisana albo wklejona zaraz po `/query`
poczeka, aż okno się otworzy.

---

## 8. Skrypty i demon

Do automatów, monitoringu i powiadomień. Bot to zwykła tożsamość — najlepiej osobny
profil (np. `ops-bot`) — którą admini mają w kontaktach i weryfikują numerem
bezpieczeństwa jak każdego.

### Wysyłanie

```sh
onchato send ewa "backup gotowy"                 # 0 = doręczono, 3 = nie doręczono w czasie
echo "dysk 92% na db1" | onchato send ewa -      # tekst ze standardowego wejścia
onchato send ewa "deploy OK" --wait 60 --json    # dłużej czekaj, wynik jako JSON
```

`send` czeka na **potwierdzenie od klienta odbiorcy** (domyślnie 20 s, `--wait`).
Kod wyjścia `3` znaczy: odbiorca nie potwierdził w tym czasie — zwykle jest offline.
Co dalej z wiadomością, zależy od tego, czy działa demon:

| | demon działa | demonu nie ma |
|---|---|---|
| jak | `send` oddaje wiadomość demonowi przez gniazdo i od razu wraca | `send` otwiera własną krótką sesję |
| odbiorca online | doręczona w ok. sekundę | doręczona po zestawieniu sesji (kilka sekund) |
| odbiorca offline | **czeka w demonie** i wychodzi sama, gdy odbiorca wróci | **przepada** (komunikat o tym na stderr) |

Wynik `--json`: `{"ok":true,"status":"delivered","id":"…","ms":412,"to":"ewa","via":"daemon"}`
(`status` = `delivered` albo `queued`, `via` = `daemon` albo `direct`).

### Odbieranie

```sh
onchato listen                       # 22:41 <ewa> restart nginx?
onchato listen --json | jq -c 'select(.t=="msg")'
```

Zdarzenia JSON (jedna linia = jedno zdarzenie):

```json
{"t":"msg","from":"ewa","pub":"…","text":"restart nginx?","ts":1791400121000,"id":"…"}
{"t":"presence","from":"ewa","pub":"…","state":"online"}
{"t":"delivered","to":"ewa","id":"…","ms":412}
{"t":"link","state":"reconnecting"}
```

Z działającym demonem `listen` podłącza się do niego; bez demona otwiera własną sesję.

### Demon

```sh
onchato daemon --profile ops-bot     # na pierwszym planie; zatrzymanie: Ctrl+C / SIGTERM
```

Demon trzyma połączenie, obecność kontaktów i otwarte rozmowy, i odpowiada na
lokalnym gnieździe `$XDG_RUNTIME_DIR/onchato.sock` (prawa `0600` — gniazdo jest całym
jego uwierzytelnieniem, więc nikt poza Tobą nie może z niego korzystać). Drugiego demona
na tym samym gnieździe nie da się uruchomić.

Przykładowa jednostka systemd (użytkownika), z hasłem przez `LoadCredential` — nie
w pliku jednostki ani w zmiennej środowiskowej:

```ini
# ~/.config/systemd/user/onchato.service
[Unit]
Description=onchato daemon (ops-bot)
After=network-online.target

[Service]
ExecStart=%h/.local/bin/onchato daemon --profile ops-bot
LoadCredential=onchato-password:%h/.config/onchato/ops-bot.pass
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
install -m 600 /dev/stdin ~/.config/onchato/ops-bot.pass <<< 'hasło profilu ops-bot'
systemctl --user daemon-reload
systemctl --user enable --now onchato
loginctl enable-linger $USER          # żeby demon działał także bez zalogowanej sesji
```

Przykład — powiadomienie o logowaniu przez SSH:

```sh
# /etc/pam.d/sshd
session optional pam_exec.so /usr/local/bin/onchato-login-notify

# /usr/local/bin/onchato-login-notify   (uruchamiany jako root - wskaż gniazdo demona bota)
#!/bin/sh
[ "$PAM_TYPE" = open_session ] || exit 0
# root nie ma ~/.local/bin w PATH - pełna ścieżka; root łączy się z gniazdem 0600 innego użytkownika
ONCHATO_SOCKET=/run/user/1000/onchato.sock /home/bot/.local/bin/onchato send admin "login: $PAM_USER z $PAM_RHOST na $(hostname)"
```

Kolejka w demonie żyje w pamięci: restart demona gubi to, co czekało. Trwała kolejka
z czasem ważności i łączeniem powtarzalnych zdarzeń to następny etap
([CLI-PLAN.md](CLI-PLAN.md), 4b).

---

## 9. Spis komend

| komenda | opis |
|---|---|
| `onchato profile new <nazwa>` | nowy profil programowy |
| `onchato profile list` | profile na tym komputerze |
| `onchato profile import <plik.ocmig>` | profil przeniesiony z aplikacji |
| `onchato profile export <nazwa> <plik.ocmig>` | profil do przeniesienia do aplikacji |
| `onchato hem new <nazwa> --hem <url>` | nowa tożsamość na HEM (z potwierdzeniem) |
| `onchato whoami` | tożsamość, klucz, odcisk |
| `onchato pubkey` | sam klucz publiczny (do skryptów) |
| `onchato contacts` | kontakty z odciskami |
| `onchato add <link\|kod> [--name n] [--yes] [--note tekst]` | kontakt z linku; przy zaproszeniu ze skrzynką — puka (`--note` dołącza krótką notatkę) |
| `onchato add <nazwa> <kluczB64>` | kontakt z surowego klucza |
| `onchato invite [--qr]` | Twój link tożsamości (i kod QR) |
| `onchato invites` · `invites new [etykieta] [--expires 24h] [--qr]` · `invites qr <nr>` · `invites revoke <nr>` | zaproszenia ze skrzynką |
| `onchato verify <nazwa> [--qr] [numer]` | numer bezpieczeństwa; porównanie z podanym |
| `onchato chat [<nazwa>] [--debug]` | klient rozmów |
| `onchato send <kontakt> <tekst \| -> [--wait s] [--json]` | jedna wiadomość (rozdział 8) |
| `onchato listen [--json]` | strumień przychodzących wiadomości |
| `onchato daemon` | demon z gniazdem lokalnym |

### Kody wyjścia

| kod | znaczenie |
|---|---|
| `0` | w porządku |
| `1` | błąd (komunikat na stderr: złe hasło, brak kontaktu, brak terminala…) |
| `3` | `send`: odbiorca nie potwierdził w czasie (czeka w demonie albo przepadła — zob. rozdział 8) |
| `4` | `verify`: numery się **nie** zgadzają |
| `130` | przerwane Ctrl+C przy pytaniu o hasło |

---

## 10. Opcje i zmienne środowiskowe

| opcja / zmienna | działanie |
|---|---|
| `--profile <nazwa>` | który profil programowy |
| `--hem <url>` | tożsamość z HEM zamiast profilu |
| `--handle <nazwa>` | która tożsamość na HEM (bez pytania) |
| `--password <hasło>` / `ONCHATO_PASSWORD` | hasło bez pytania — uwaga: widoczne w historii powłoki i liście procesów; w skryptach lepiej zmienna albo prompt |
| `--password-file <plik>` | hasło z pierwszej linii pliku (`0600`); pod systemd zamiast tego `LoadCredential=onchato-password:…` |
| `--yes` | bez pytania t/N (skrypty) |
| `--wait <s>`, `--json` | `send`: jak długo czekać na potwierdzenie; wynik jako JSON |
| `ONCHATO_SOCKET` | gniazdo demona (domyślnie `$XDG_RUNTIME_DIR/onchato.sock`) |
| `--debug` | w kliencie: dziennik silnika w oknie statusu |
| `--libp2p` | w kliencie: pełny transport GossipSub zamiast lekkiego (diagnostyka) |
| `ONCHATO_HOME` | katalog danych (domyślnie `$XDG_CONFIG_HOME/onchato`, czyli `~/.config/onchato`) |

Hasło bez terminala (potok): `onchato` czyta pierwszą linię ze standardowego wejścia.

---

## 11. Gdzie są dane i jak są chronione

Wszystko jest w `~/.config/onchato/store.json` (katalog `0700`, plik `0600`,
zapisywany atomowo). Klucze i formaty są takie same jak w aplikacji, dlatego
profil przenosi się w obie strony bez konwersji.

| co | jak chronione |
|---|---|
| tożsamość (profil programowy) | zapieczętowana Twoim hasłem (PBKDF2 1 000 000 rund + AES-GCM); klucza prywatnego nie ma nigdzie jawnie |
| kontakty | podpisane (HMAC kluczem wyprowadzonym z tożsamości) — podmiana kontaktu w pliku jest wykrywana, a `onchato` odmawia pracy na takiej książce i jej nie nadpisuje |
| zaproszenia, pukania, lista ignorowanych | zaszyfrowane kluczem wyprowadzonym z tożsamości |
| historia rozmów | **nie ma jej** — rozmowa istnieje tylko na ekranach uczestników |

Na serwerze lepszy jest HEM: klucz nie opuszcza urządzenia, a kradzież pliku nic nie daje.

---

## 12. Ograniczenia, które warto znać

- **Rozmowa wymaga obecności.** onchato nie przechowuje wiadomości w sieci. Wiadomość
  dochodzi, gdy rozmówca jest online; jeśli nie jest, czeka u Ciebie, dopóki klient
  działa. Po zamknięciu klienta nic nie czeka.
- **Jedna tożsamość, jedna sesja.** Ta sama tożsamość otwarta jednocześnie w aplikacji
  i w terminalu (albo w dwóch terminalach) zamyka obie sesje. Do rozmowy z samym sobą
  użyj dwóch różnych tożsamości.
- **Zaproszenie słucha tylko, gdy klient działa.** Bez uruchomionego `onchato chat`
  pukanie nie ma dokąd dojść.
- **Jeszcze nie ma**: pobierania i wysyłania plików, grup, przewijania historii okna
  (PgUp), wskaźnika pisania, trwałej kolejki powiadomień. Kolejność w [CLI-PLAN.md](CLI-PLAN.md).

---

## 13. Rozwiązywanie problemów

**Alt+cyfra nie przełącza okien.** Terminal wysyła Alt inaczej (np. jako znak z
akcentem). Ustaw w terminalu „Meta wysyła Escape” (GNOME Terminal, Konsole, iTerm2:
„Option as Meta”) albo używaj `/win N`.

**Pukanie do zaproszenia nie przychodzi.**
1. Czy `onchato chat` działa i w statusie widać „słucham N zaproszeń”?
2. Czy ta osoba nie ma Cię już w kontaktach? Aplikacja wtedy nie puka — pokazuje
   „Ten sam klucz, który masz zapisany”. Pukanie od istniejącego kontaktu klient
   zgłasza w statusie jedną linią.
3. Aplikacja ponawia pukanie co 90 s — daj jej chwilę.

**„złe hasło” przy pewnym haśle.** Hasło jest per profil. Sprawdź `onchato profile list`
i `--profile`.

**„książka kontaktów nie przeszła weryfikacji podpisu”.** Ktoś (albo coś) zmienił
`store.json` poza `onchato`. Nic nie jest nadpisywane — to dowód. Przywróć plik
z kopii albo usuń wpis `ec-local-contacts-…` i dodaj kontakty od nowa.

**Terminal został w dziwnym stanie** (np. po zabiciu procesu): wpisz `reset`.

**„ta tożsamość otworzyła się w drugim miejscu”.** Masz tę samą tożsamość otwartą
w aplikacji albo w drugim terminalu — zamknij jedno z nich i uruchom ponownie.
