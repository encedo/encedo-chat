# onchato-bot — a bot on your own server

The bot is a separate onchato identity on your server. It sends you reports, answers
commands from a fixed list, and lets admins add contacts and make invites straight from
the chat. Everything is end-to-end encrypted, like any onchato conversation. Setting it
up takes about 15 minutes.

Requires **onchato-cli 0.7.45 or newer** (the daemon takes contacts and makes invites
without a restart; earlier versions also had a presence bug that could stall the queue).

```
┌──────────── container: onchato-cli daemon ──────────┐
│ identity, keys, network, queue (volume /data)       │
│ socket /data/onchato.sock = /srv/onchato on the host│
└────────────────────────▲────────────────────────────┘
                         │ one JSON line each way
┌────────────────────────┴────────────────────────────┐
│ onchato-bot.py (host, Python 3.8+, no dependencies) │
│ /etc/onchato/bot.json: commands -> programs, admins │
└─────────────────────────────────────────────────────┘
```

The bot holds no keys: everything about identity and network is the daemon's job. The
bot only turns a message into a program from the list.

---

## 1. The daemon in Docker

```bash
git clone --recurse-submodules https://github.com/encedo/encedo-chat
cd encedo-chat && git checkout v0.7.45      # or a newer tag
docker build -t onchato .

sudo install -d -o 1000 -g 1000 -m 700 /srv/onchato              # the daemon's data, visible from the host
docker run --rm -it -v /srv/onchato:/data onchato profile new mybot   # password twice

sudo install -d -m 700 /etc/onchato
read -rs -p 'bot password: ' P; echo
printf '%s\n' "$P" | sudo install -m 600 -o 1000 -g 1000 /dev/stdin /etc/onchato/bot.pass; unset P

docker run -d --name onchato --restart unless-stopped --memory 256m \
  -v /srv/onchato:/data \
  --mount type=bind,src=/etc/onchato/bot.pass,dst=/run/secrets/onchato-password,ro \
  onchato daemon
docker logs -f onchato
```

The container runs as uid 1000, hence the owner of the directory and the password file.
Never put the password on a command line or in an environment variable — both show in
`ps` and in the shell history. The daemon takes ~90 MB with a few contacts and grows with
each open conversation; 256 MB leaves room.

## 2. The first contact: you

The bot needs your key and you need its. With the daemon running, `add` goes through it:

```bash
docker exec -it onchato onchato-cli add 'https://app.onchato.com/#i=...' --name me
```

- **An identity link** (in the app: "Share your profile"): the bot prints a **reply
  link** — open it in the app.
- **An invite with an inbox**: the daemon knocks, and again every 90 s, until you accept
  in the app.

Compare the fingerprint `add` shows with the one in the app. Your fingerprint as the bot
sees it is in `docker exec onchato onchato-cli contacts` — you need it below, as an admin.

Test: `docker exec onchato onchato-cli send me "test"` — exit 0 = delivered, 3 = waiting
in the daemon's queue, it goes out when you are online.

## 3. The bot

```bash
sudo install -d /opt/onchato-bot
sudo cp tools/onchato-bot/onchato-bot.py /opt/onchato-bot/
sudo cp tools/onchato-bot/bot.example.json /etc/onchato/bot.json     # and edit it
sudo cp tools/onchato-bot/onchato-bot.service /etc/systemd/system/
python3 /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json check
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-bot
```

`check` validates the config and reaches the daemon. Then write `ping` to the bot.

### Configuration (`/etc/onchato/bot.json`)

```json
{
  "socket": "/srv/onchato/onchato.sock",
  "name": "server1",
  "lang": "en",
  "admins": ["E1:30:1D:E1:0D:F8:32:88"],
  "answer": "contacts",
  "reports": { "to": ["me"], "ttl": "7d" },
  "commands": {
    "ping":   { "run": ["echo", "pong"] },
    "disk":   { "run": ["df", "-h", "/"] },
    "docker": { "run": ["docker", "ps", "--format", "{{.Names}}  {{.Status}}"], "admin": true },
    "logs":   { "run": ["journalctl", "-u", "{unit}", "-n", "20", "--no-pager"],
                "args": { "unit": "^(nginx|ssh|docker)$" }, "admin": true }
  }
}
```

| field | meaning |
|---|---|
| `socket` | the daemon's socket (the directory from step 1) |
| `name` | prefix of every answer, `[server1] …` — handy with several servers |
| `lang` | `en` or `pl`: the language of help for unknown text and of what the bot says unasked (knocks); a built-in command is always answered in the language it was written in |
| `admins` | admins' key **fingerprints** (`onchato-cli contacts`), not names |
| `answer` | `contacts` — answers every contact; `admins` — admins only |
| `reports.to` | who gets `run` and `notify`; `ttl` — how long they wait in the queue |
| `commands` | command → program (`run`, an argument list, no shell) |
| `commands.*.args` | arguments from the message: only declared ones, each with a regex it must match whole; it replaces only a `run` element that is exactly `{name}` |
| `commands.*.admin` | `true` — admins only |
| `rate_seconds`, `timeout_seconds` | one answer per contact per that many seconds (not for admins); the program's time limit |

A new command is one line in `commands` and `systemctl restart onchato-bot`.

### Commands in the chat

Built-in commands work in English and in Polish; the answer comes in the language asked.

| you write | who | what happens |
|---|---|---|
| `ping`, `disk`, … | any contact (an admin, with `admin: true`) | the program's output |
| `logs nginx` | admin | the argument is checked by its regex; `logs nginx;reboot` is refused |
| `help`, or anything else | anyone | the commands this person may use |
| `add <link> [name]` · `dodaj` | admin | the bot shows the name and **fingerprint** from the link and asks: `yes 3946` |
| `yes 3946` · `tak` | admin | the contact is added at once (no restart); for an invite the bot knocks until they accept, for an identity link it hands back a reply link |
| `knocks` · `pukania` | admin | who is knocking on the bot's invites |
| `accept 1`, `ignore 1` · `przyjmij`, `ignoruj` | admin | decide on a knock |
| `invite [label] [7d]` · `zaproszenie` | admin | a new invite for the bot; the answer is the link, the daemon listens at once |
| `invites`, `revoke 1` · `zaproszenia`, `wycofaj` | admin | invites with their links; withdraw one (nobody is told) |

When someone knocks on the bot's invite, every admin gets a message with the fingerprint
and the number for `accept`. Invites are made by the daemon — from the chat
(`invite bot 7d`) or on the server:

```bash
docker exec onchato onchato-cli invites new bot --expires 7d   # prints the link; the daemon listens at once
docker exec onchato onchato-cli invites                         # the list; invites revoke <n> withdraws
```

### Reports

`run` runs a command from the config and sends its output to `reports.to`; `notify`
sends standard input:

```ini
# /etc/systemd/system/onchato-report.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json run disk

# /etc/systemd/system/onchato-report.timer
[Timer]
OnCalendar=*-*-* 08,20:00
[Install]
WantedBy=timers.target
```

```bash
echo "backup done" | python3 /opt/onchato-bot/onchato-bot.py --config /etc/onchato/bot.json notify
```

Every report waits in the queue on its own (7 days by default): when you come back, you
get all of them, in order.

## 4. Security rules

- The bot never runs a shell and never pastes message text into a command — an argument
  exists only where the config declares it, with a regex.
- An admin is a **key**, not a name. A stolen admin phone can add contacts; those contacts
  can still do only what commands without `admin: true` allow.
- Adding a contact needs the fingerprint confirmed (`yes <code>`), valid for 5 minutes.
- A stranger cannot write to the bot: the daemon talks to contacts only. Groups are ignored.
- A program from `run` runs with the service's rights (root by default, to read the
  journal and Docker). For less, set `User=` in the unit and give that user access to the
  socket (owned by uid 1000) and to what the commands read.

## 5. Known traps

| symptom | cause | what to do |
|---|---|---|
| „ta tożsamość otworzyła się w drugim miejscu” ("this identity opened somewhere else") | `chat` or a second daemon on the bot's identity | stop one; with the daemon running use `docker exec onchato onchato-cli …` |
| messages to a phone wait | Android and iOS put the app to sleep in the background | normal: the queue keeps them for `ttl` and sends when the app opens |
| the bot goes quiet after a daemon restart | the event stream broke | systemd restarts the bot after 5 s; `journalctl -u onchato-bot` |
| times in the logs are off | the container runs in UTC | `-e TZ=Europe/Warsaw` (your zone) on `docker run` |

Updating: `git pull`, `docker build -t onchato .`, `docker rm -f onchato`, the same
`docker run`; the profile and the queue stay in `/srv/onchato`. The bot: copy the new
`onchato-bot.py` and `systemctl restart onchato-bot`.

Tests: `cd tools/onchato-bot && python3 -m unittest -v`; live over the real nodes:
`sh tools/onchato-bot/live-test.sh`. The socket protocol: the header of
`impl/cli/daemon.ts`.
