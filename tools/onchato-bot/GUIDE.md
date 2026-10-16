# onchato-bot — bot na własnym serwerze

Bot to osobna tożsamość onchato na Twoim serwerze. Wysyła Ci raporty, odpowiada na
polecenia z ustalonej listy i daje adminom dodawać kontakty prosto z czatu. Wszystko
szyfrowane end-to-end, jak każda rozmowa w onchato. Postawienie zajmuje ok. 15 minut.

Wymagana wersja: **onchato-cli 0.7.45 lub nowsza** (demon przyjmuje kontakty bez
restartu; wcześniejsze wersje mają też błąd obecności, przez który kolejka potrafiła
stać).

```
┌──────────── kontener: onchato-cli daemon ────────────┐
│ tożsamość, klucze, sieć, kolejka (wolumen /data)     │
│ gniazdo /data/onchato.sock = /srv/onchato na hoście  │
└────────────────────────▲─────────────────────────────┘
                         │ jedna linia JSON w każdą stronę
┌────────────────────────┴─────────────────────────────┐
│ onchato-bot.py (host, Python 3.8+, bez zależności)   │
│ /etc/onchato/bot.json: polecenia -> programy, admini │
└──────────────────────────────────────────────────────┘
```

Bot nie ma żadnych kluczy: wszystko, co dotyczy tożsamości i sieci, robi demon. Bot tylko
tłumaczy wiadomość na program z listy.

---

## 1. Demon w Dockerze

```bash
git clone --recurse-submodules https://github.com/encedo/encedo-chat
cd encedo-chat && git checkout v0.7.45      # albo nowszy tag
docker build -t onchato .

sudo install -d -o 1000 -g 1000 -m 700 /srv/onchato          # dane demona, widoczne z hosta
docker run --rm -it -v /srv/onchato:/data onchato profile new mojbot   # hasło dwa razy

sudo install -d -m 700 /etc/onchato
read -rs -p 'haslo bota: ' P; echo
printf '%s\n' "$P" | sudo install -m 600 -o 1000 -g 1000 /dev/stdin /etc/onchato/bot.pass; unset P

docker run -d --name onchato --restart unless-stopped --memory 200m \
  -v /srv/onchato:/data \
  --mount type=bind,src=/etc/onchato/bot.pass,dst=/run/secrets/onchato-password,ro \
  onchato daemon
docker logs -f onchato
```

Kontener działa jako uid 1000, stąd właściciel katalogu i pliku z hasłem. Hasła nie
wpisuj w linię poleceń ani w zmienną środowiskową — widać je w `ps` i w historii.

## 2. Pierwszy kontakt: Ty

Bot musi mieć Twój klucz, a Ty jego. Przy działającym demonie `add` idzie przez demona:

```bash
docker exec -it onchato onchato-cli add 'https://app.onchato.com/#i=...' --name ja
```

- **Link tożsamości** (w aplikacji: „Udostępnij swój profil”): bot wypisze **link
  zwrotny** — otwórz go w aplikacji.
- **Zaproszenie ze skrzynką**: demon puka i ponawia co 90 s, aż przyjmiesz w aplikacji.

Porównaj odcisk, który pokazuje `add`, z odciskiem w aplikacji. Swój odcisk w bocie
zobaczysz w `docker exec onchato onchato-cli contacts` — przyda się za chwilę jako admin.

Test: `docker exec onchato onchato-cli send ja "test"` — kod 0 = doręczono, 3 = czeka
w kolejce demona i wyjdzie, gdy będziesz online.

## 3. Bot

```bash
sudo install -d /opt/onchato-bot
sudo cp tools/onchato-bot/onchato-bot.py /opt/onchato-bot/
sudo cp tools/onchato-bot/bot.example.json /etc/onchato/bot.json     # i edytuj
sudo cp tools/onchato-bot/onchato-bot.service /etc/systemd/system/
python3 /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json check
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-bot
```

`check` sprawdza konfigurację i łączy się z demonem. Napisz do bota `ping`.

### Konfiguracja (`/etc/onchato/bot.json`)

```json
{
  "socket": "/srv/onchato/onchato.sock",
  "name": "serwer1",
  "admins": ["E1:30:1D:E1:0D:F8:32:88"],
  "answer": "contacts",
  "reports": { "to": ["ja"], "ttl": "7d" },
  "commands": {
    "ping":   { "run": ["echo", "pong"] },
    "dysk":   { "run": ["df", "-h", "/"] },
    "docker": { "run": ["docker", "ps", "--format", "{{.Names}}  {{.Status}}"], "admin": true },
    "logi":   { "run": ["journalctl", "-u", "{unit}", "-n", "20", "--no-pager"],
                "args": { "unit": "^(nginx|ssh|docker)$" }, "admin": true }
  }
}
```

| pole | znaczenie |
|---|---|
| `socket` | gniazdo demona (katalog z kroku 1) |
| `name` | przedrostek odpowiedzi, `[serwer1] …` — przydaje się przy kilku serwerach |
| `admins` | **odciski** kluczy adminów (`onchato-cli contacts`), nie nazwy |
| `answer` | `contacts` — odpowiada każdemu kontaktowi; `admins` — tylko adminom |
| `reports.to` | komu idą `run` i `notify`; `ttl` — jak długo czekają w kolejce |
| `commands` | polecenie → program (`run`, lista argumentów, bez powłoki) |
| `commands.*.args` | argumenty z wiadomości: tylko zadeklarowane, każdy z regexem, który musi pasować w całości; trafia wyłącznie w element `run` równy dokładnie `{nazwa}` |
| `commands.*.admin` | `true` — polecenie tylko dla adminów |
| `rate_seconds`, `timeout_seconds` | 1 odpowiedź na kontakt co tyle sekund (adminów nie dotyczy); limit czasu programu |

Nowe polecenie to jedna linia w `commands` i `systemctl restart onchato-bot`.

### Polecenia w czacie

| piszesz | kto | co się dzieje |
|---|---|---|
| `ping`, `dysk`, … | każdy kontakt (albo admin, gdy `admin: true`) | wynik programu |
| `logi nginx` | admin | argument sprawdzony regexem; `logi nginx;reboot` jest odrzucane |
| cokolwiek innego | każdy | lista poleceń, które ta osoba może wydać |
| `dodaj <link> [nazwa]` | admin | bot pokazuje nazwę i **odcisk** z linku i prosi: `tak 3946` |
| `tak 3946` | admin | kontakt dodany od razu (bez restartu); przy zaproszeniu bot puka, aż przyjmą, przy linku tożsamości odsyła link zwrotny |
| `pukania` | admin | kto puka do zaproszeń bota |
| `przyjmij 1`, `ignoruj 1` | admin | decyzja o pukaniu |
| `zaproszenie [etykieta] [7d]` | admin | nowe zaproszenie bota; odpowiedź to link, demon słucha od razu |
| `zaproszenia`, `wycofaj 1` | admin | lista zaproszeń z linkami; wycofanie (nikt nie jest informowany) |

Gdy ktoś zapuka do zaproszenia bota, każdy admin dostaje wiadomość z odciskiem i numerem
do `przyjmij`. Zaproszenie robi demon — z czatu (`zaproszenie bot 7d`) albo z serwera:

```bash
docker exec onchato onchato-cli invites new bot --expires 7d   # wypisze link; demon od razu słucha
docker exec onchato onchato-cli invites                         # lista; invites revoke <nr> wycofuje
```

### Raporty

`run` uruchamia polecenie z konfiguracji i wysyła wynik do `reports.to`; `notify` wysyła
standardowe wejście:

```ini
# /etc/systemd/system/onchato-raport.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json run dysk

# /etc/systemd/system/onchato-raport.timer
[Timer]
OnCalendar=*-*-* 08,20:00
[Install]
WantedBy=timers.target
```

```bash
echo "backup gotowy" | python3 /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json notify
```

Każdy raport czeka w kolejce osobno (domyślnie 7 dni): po powrocie dostaniesz wszystkie
po kolei.

## 4. Zasady bezpieczeństwa

- Bot nigdy nie uruchamia powłoki i nie wkleja tekstu z wiadomości w polecenie —
  argument istnieje tylko tam, gdzie konfiguracja go zadeklarowała, z regexem.
- Admin to **klucz**, nie nazwa. Przejęty telefon admina może dodawać kontakty; dodane
  kontakty mogą jednak tylko to, co polecenia bez `admin: true`.
- Dodanie kontaktu wymaga potwierdzenia odcisku (`tak <kod>`), ważnego 5 minut.
- Obcy nie napisze do bota: demon rozmawia tylko z kontaktami. Grupy bot pomija.
- Program z `run` działa z uprawnieniami usługi (domyślnie root, żeby czytać dziennik
  i Dockera). Wolisz mniej — ustaw `User=` w jednostce i daj temu użytkowi dostęp do
  gniazda (właściciel uid 1000) i do tego, co polecenia czytają.

## 5. Pułapki

| objaw | przyczyna | co zrobić |
|---|---|---|
| „ta tożsamość otworzyła się w drugim miejscu” | `chat` albo drugi demon na tożsamości bota | zatrzymaj jedno; przy działającym demonie używaj `docker exec onchato onchato-cli …` |
| wiadomości do telefonu czekają | Android i iOS usypiają aplikację w tle | normalne: kolejka trzyma je `ttl` i wysyła po otwarciu aplikacji |
| bot milczy po restarcie demona | strumień zdarzeń się zerwał | systemd podnosi bota po 5 s; `journalctl -u onchato-bot` |
| godziny w logach przesunięte | kontener liczy w UTC | `-e TZ=Europe/Warsaw` przy `docker run` |

Aktualizacja: `git pull`, `docker build -t onchato .`, `docker rm -f onchato`, ten sam
`docker run`; profil i kolejka zostają w `/srv/onchato`. Bot: skopiuj nowy
`onchato-bot.py` i `systemctl restart onchato-bot`.

Testy: `cd tools/onchato-bot && python3 -m unittest -v`; na żywo przez prawdziwe węzły:
`sh tools/onchato-bot/live-test.sh`. Protokół gniazda: nagłówek `impl/cli/daemon.ts`.
