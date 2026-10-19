# onchato in the terminal — manual

`onchato-cli` is the terminal client of onchato: the same network, the same encryption and
the same identities as the app. You talk to anyone who uses the app
from a terminal window, over SSH or inside `screen`/`tmux`. The interface is
modelled on irssi: every conversation has its own window, and the status bar at the bottom shows
where something is happening.

This manual describes version 0.7.45. The plan for further stages (script mode,
daemon, notifications, files, groups) is in [CLI-PLAN.md](CLI-PLAN.md).

---

## Contents

1. [Installation](#1-installation)
2. [Getting started](#2-getting-started)
3. [Identity: profile or HEM](#3-identity-profile-or-hem)
4. [Contacts](#4-contacts)
5. [Invites that answer by themselves](#5-invites-that-answer-by-themselves)
6. [Verification: the safety number](#6-verification-the-safety-number)
7. [The chat client](#7-the-chat-client)
8. [Scripts and the daemon](#8-scripts-and-the-daemon)
9. [Command reference](#9-command-reference)
10. [Options and environment variables](#10-options-and-environment-variables)
11. [Where the data lives and how it is protected](#11-where-the-data-lives-and-how-it-is-protected)
12. [Limitations worth knowing](#12-limitations-worth-knowing)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Installation

Requires **Node.js 24** or newer (it runs the TypeScript code directly).

For now `onchato-cli` runs from the repository. The easiest way is to link it as an
ordinary command:

```sh
mkdir -p ~/.local/bin
ln -s <repo>/impl/cli/onchato.ts ~/.local/bin/onchato-cli
onchato-cli        # no arguments: a short cheat sheet
```

The command is called `onchato-cli` because `onchato` is the packaged desktop app
(`/usr/bin/onchato`). The `~/.local/bin/onchato` symlink from earlier versions
shadowed it in `PATH`, and the icon launched the CLI instead of the window - rename it:
`mv ~/.local/bin/onchato ~/.local/bin/onchato-cli`.

`~/.local/bin` is in `PATH` on most distributions (after logging in again).
The symlink points into the repository, so `git pull` gives you the new version right away.

### Docker

For a server without Node 24, or when the daemon should live in a container. The image contains only the CLI;
the data (profile, contacts, queue, downloaded files) is in the `/data` volume, and the daemon
listens on the socket `/data/onchato.sock`. In the container it runs as an ordinary user
(uid 1000), not as root.

```sh
docker build -t onchato .                          # from the repository root

# once: a profile in the volume (interactive - asks for the password)
docker run --rm -it -v onchato:/data onchato profile new ops-bot
docker run --rm -it -v onchato:/data onchato add <invite link or name key>

# daemon in the background; password from a file mounted as a secret - not in an environment variable
install -m 600 /dev/stdin ./ops-bot.pass <<< 'ops-bot profile password'
docker run -d --name onchato --restart unless-stopped -v onchato:/data \
  --mount type=bind,src=$PWD/ops-bot.pass,dst=/run/secrets/onchato-password,ro \
  onchato daemon

# scripts on the host talk to the daemon through docker exec
docker exec onchato onchato-cli send ewa "backup gotowy"
docker exec onchato onchato-cli listen --json
docker logs -f onchato
```

The password file must be readable by uid 1000 in the container (owner 1000, or
`chmod 644` in a directory nobody else can access). In docker compose or
Swarm, `secrets:` named `onchato-password` does the same — the image looks for the password
in `/run/secrets/onchato-password`.

The chat client works in a container too, with a terminal: `docker run --rm -it -v onchato:/data
onchato chat`. Just not in parallel with the daemon on the same identity — one
identity is one session (section 12).

---

## 2. Getting started

Five minutes from zero to a conversation with someone who has the app:

```sh
onchato-cli profile new ala                      # 1. identity (password, twice)
onchato-cli invite --qr                          # 2. your code - the other person scans it in the app
onchato-cli add 'https://app.onchato.com/#i=…'   # 3. or you add their link (shows the fingerprint, asks)
onchato-cli verify ewa                           # 4. compare the safety number
onchato-cli chat                                 # 5. client: contact list, /query 1, type away
```

A conversation starts only once **both sides have each other's keys**.
Hence the three ways of adding a contact described in section 4.

---

## 3. Identity: profile or HEM

### Software profile

A key pair generated on this computer, sealed with a password — the same
format as a profile in the app.

```sh
onchato-cli profile new <name>      # you enter the password twice
onchato-cli profile list
```

The password must be strong (the full meter, about 60 bits) — the same rule as
in the app. The simplest way: two or three ordinary words (`kot pies dom lampa`).
**A profile cannot be recovered** — without the password there is no way into it.

### Moving a profile from the app and back

```sh
onchato-cli profile import ala.ocmig             # file from the app: Ustawienia → Przenieś profil (Settings → Move profile)
onchato-cli profile export ala ala.ocmig         # and the other way round
```

What moves: the identity, contacts, invites and the node list. This is
**a move, not a copy**: the same identity open in two places at once
closes both sessions (see section 12).

### HEM

The key lives in the device and never leaves it. Add `--hem <url>` to every command:

```sh
onchato-cli whoami --hem https://my.ence.do
onchato-cli chat --hem https://my.ence.do
```

- If the HEM holds **several identities**, `onchato` shows a numbered list and asks
  which one to use. `--handle <name>` picks one without asking.
- Signing in **never creates** an identity. You create a new one deliberately:

  ```sh
  onchato-cli hem new <name> --hem https://my.ence.do
  ```

- Contacts stored in the HEM appear alongside the local ones (`onchato-cli contacts`
  shows the source: `hem` or `local`).

### Which profile

Without `--profile` and without `--hem`, `onchato` uses the only profile there is. When there are
several, choose with `--profile <name>`.

### Another operator's network

An identity lives in one network for good. To join another operator's network, make a NEW profile
from the operator's signed network profile - a file, or the short link with its CID that the
operator publishes (`…/network.json#onchato-net=bafkrei…`):

```sh
onchato-cli profile new work --network-profile acme-network.json
```

`onchato` shows the operator, the network id and the fingerprint of the operator's key - compare
it with what the operator gave you another way - and asks before joining. From then on that
profile always runs in that network: its nodes, its file store, invite links to its app.
`profile list` names each profile's network, `whoami` says which network this run is in. A HEM
identity is put in a network with `--network <id>` on its first sign-in on this device.

A network may admit only devices its administrator lets in. The first run of such a profile on
this device asks for the administrator's current 8-digit code (or takes it from `--access-code`,
or `ONCHATO_ACCESS_CODE` in a script; `--device-name` is the name the administrator sees). The
node then recognises this device by a fixed number of its own - never your identity key - and
`whoami` prints it. Without the code it says so and stops, rather than retrying a node that
refuses it.

---

## 4. Contacts

```sh
onchato-cli contacts                 # name, key fingerprint, source
```

Three ways to add a contact:

| method | how | what next |
|---|---|---|
| **identity link** | `onchato-cli add '<link>'` (a link from the app: „Udostępnij swój profil” ("Share your profile")) | `onchato` prints a **return link** — send it back to that person so they have your key too |
| **your QR code** | `onchato-cli invite --qr`, the other person scans it in the app | they add you; you add them with their return link |
| **mailbox invite** | section 5 | they knock, and after `/accept` you have each other — no links sent back and forth |

`add` accepts the link in any form: the full address, just the `#i=…` fragment, or the bare
code. It shows **the name and the key fingerprint** and asks `t/N` — compare the fingerprint with what that
person gave you over another channel (in person, by phone). In a script: `--yes`.

```sh
onchato-cli add '<link>' --name "Ewa z biura"    # your own name instead of the one in the link
onchato-cli add ewa <keyB64>                     # raw public key (32 bytes, base64)
```

The name in the link is only a claim — the key decides the identity.

---

## 5. Invites that answer by themselves

A mailbox invite is a link (and a QR code) you can post anywhere.
Whoever opens it **knocks** with their key; you see the knock with its fingerprint and decide.
Once accepted, you are in each other's contacts.

```sh
onchato-cli invites new biuro --expires 24h --qr   # new invite (time: 30m, 24h, 7d; without --expires - no expiry)
onchato-cli invites                                # list with links
onchato-cli invites qr 1                           # QR code of invite no. 1
onchato-cli invites revoke 1                       # revoke - nobody is notified
```

When the daemon is running, `invites` goes **through it**: the daemon creates and revokes
the invite (it holds `store.json` in memory — a change written next to it would be
overwritten) and starts listening on it at once. No restart needed.

**Knocks show up in the client** (`onchato-cli chat`) **or in the daemon** (`onchato-cli daemon`,
section 8) — an invite "listens" only while one of them is running:

```
23:04 -!- Ewa puka (zaproszenie „biuro”) · odcisk 71:84:64:2F:8E:66:01:E7 - /accept 1 · /ignore 1
```

| in the client | action |
|---|---|
| `/knocks` | list of pending knocks |
| `/accept N` | adds that person to your contacts |
| `/ignore N` | ignores that key — further knocks from it will not show up |

With the daemon running, the commands `onchato-cli knocks`, `onchato-cli accept N`
and `onchato-cli ignore N` do the same; the knock also goes to the daemon's log and, as the event
`{"t":"knock",…}`, to `listen --json`. An accepted contact works at once, without restarting the daemon.

Accepting is always manual. An invite is public and lives until you
revoke it — anyone who has ever seen the code can knock.

**The other way round:** `onchato-cli add '<invite link>'` adds the contact and knocks.
If the inviter happens to be offline, the client (`onchato-cli chat`) or the daemon keeps knocking
every 90 s until they accept — then you see „… przyjął(a) Twoje pukanie” ("… accepted your knock"). A single knock
is often lost (nobody happens to be listening), so this retrying matters.

When the daemon is running, `add` hands the contact **to it** — it does not open a second session of the same
identity, and the daemon knows the new contact right away.

Invites move with the profile between the app and the terminal.

---

## 6. Verification: the safety number

```sh
onchato-cli verify ewa               # 60 digits, identical for both of you
onchato-cli verify ewa --qr          # the same as a QR code
onchato-cli verify ewa 38421 99404 … # compare with the number read out by the other person
```

Compare the number in person or over the phone (in the app it is in the window under 🔐,
where you can also scan the QR code). A matching number means nobody is impersonating
either of you. When comparing, `verify` exits with code `0` (match) or `4`
(mismatch) — handy in scripts.

---

## 7. The chat client

```sh
onchato-cli chat               # starts at the contact list
onchato-cli chat ewa           # with the conversation with ewa already open
```

The client needs a real terminal. It takes over the whole screen (like irssi or `less`)
and restores the terminal to its previous state on exit.

### Screen

```
22:39 <ewa> cześć, testujesz CLI?             ← window: the current conversation
22:39 <ala> tak, z terminala przez ssh
22:41 -!- plik od ewa: raport.pdf (1.2 MB)     ← -!- marks system messages
[22:42] [ala·HEM] [bs1 ●] [2:ewa 🔐] [Act: 3,4]  ← status bar
[ewa] you type here▌                           ← input line
```

The status bar:

| field | meaning |
|---|---|
| `[22:42]` | time |
| `[ala·HEM]` | your identity and its kind (`HEM` / `software`) |
| `[bs1 ●]` | node and connection: green ● connected, red ● none, yellow ○ connecting |
| `[2:ewa 🔐]` | current window; 🔐 = session secured (EH-2 key agreement complete) |
| `[Act: 3,4]` | windows with new messages; in purple — a mention of you |

### Windows

- Window **1** is the status window: startup, connection, contact list, knocks on invites.
- Each conversation gets the next free number and keeps it until you close it.
- When someone starts a conversation with you, their window opens **in the background**: a notice
  appears in the status window and on the `Act:` bar — your view does not move.

### Keys

| key | action |
|---|---|
| **Alt+1 … Alt+9** | switch window (Alt+0 = window 10) |
| **Tab** | after `/query ` — complete a contact name |
| **Enter** | send a message or run a command |
| **← →**, **Home** / **End**, **Ctrl+A** / **Ctrl+E** | move within the line |
| **Backspace**, **Delete** | delete |
| **Ctrl+W** | delete the word before the cursor |
| **Ctrl+U** | delete to the start of the line |
| **↑ ↓** | history of entered lines |
| **Ctrl+L** | redraw the screen |
| **Ctrl+C**, **Ctrl+D** | quit (like `/quit`) |

### Commands

| command | action |
|---|---|
| `/list` | contacts with presence (● online, ○ offline), numbered |
| `/query <no>` · `/query <name>` · `/q …` | open a conversation or a group window |
| `/win <no>` · `/w <no>` | switch window |
| `/close` | close the current conversation |
| `/who` | whether the other person is in the room right now |
| `/me <action>` | an action („* ala macha”) |
| `/react <emoji>` | react to the other person's last message |
| `/verify` | safety number of this conversation |
| `/invite` | your identity link |
| `/send <path>` | send a file (section 8, "Files") |
| `/get [id]` | save a received file (without an id — the last one in this window) |
| `/knocks` · `/accept N` · `/ignore N` | knocks on your invites (section 5) |
| `/groups` · `/group new <name> <contact\|no>…` | groups (see "Groups" below) |
| `/add <contact\|no>` · `/kick <who>` · `/rename <name>` | admin, in a group window: membership and name |
| `/clear` | clear the current window |
| `/help` | cheat sheet |
| `/quit` · `/exit` | quit (the people you talk to are told you left) |

Lines run in order — a message typed or pasted right after `/query`
waits until the window opens.

### Groups

```
/group new zespol ewa 3          # a group with contacts ewa and no. 3 from /list; you are the admin
/groups                          # your groups and their windows
/query zespol                    # the group window (or /win N)
@ewa sprawdzisz deploy?          # in a group window you write to everyone; @Name is a mention
/who                             # members: presence, admin, not in contacts, pending invites
/send raport.pdf                 # a file to the whole group

# admin, in the group window:
/add 4                           # add contact no. 4 from /list (or by name)
/kick ewa                        # remove a member (contact or a name from /who)
/rename ops                      # rename the group
```

- A group invite arrives by itself: „dołączono do grupy …” ("joined group …") appears in the status window
  and the group gets its own window. Your group key then goes to the other members.
- A **mention** (`@Name`) shows up for the recipient as a mention — in purple on the status bar,
  stronger than ordinary activity. Everyone sees the name they themselves gave
  that person.
- **All members must have each other in their contacts.** Group keys travel over
  1:1 conversations, so with someone outside your contacts you will not see each other's messages —
  the client says so in the group window and in `/who`.
- An invite for someone offline waits and goes out when they appear, even after a restart.
- Groups are stored encrypted, in the same format as in the app — they move
  with the profile.
- `/close` in a group window closes only the window; you are still in the group.
- **A membership change is a new epoch.** `/add` and `/kick` give the group new keys and a new
  topic, and only the new membership gets the new keys. A removed person cannot read anything
  said from that moment on (it does not undo earlier messages). `/rename` does not change
  the keys. Only the admin, i.e. the group's creator, changes membership and name.
- Scripts can write to a group: `onchato-cli send <group> "text"` (section 8).

---

## 8. Scripts and the daemon

For automation, monitoring and notifications. A bot is an ordinary identity — ideally a separate
profile (e.g. `ops-bot`) — that admins keep in their contacts and verify with the safety
number like anyone else.

### Sending

```sh
onchato-cli send ewa "backup gotowy"                 # 0 = delivered, 3 = not delivered in time
echo "dysk 92% na db1" | onchato-cli send ewa -      # text from standard input
onchato-cli send ewa "deploy OK" --wait 60 --json    # wait longer, result as JSON
```

`send` waits for **a confirmation from the recipient's client** (20 s by default, `--wait`).
Exit code `3` means: the recipient did not confirm in that time — usually they are offline.
What happens to the message next depends on whether the daemon is running:

| | daemon running | no daemon |
|---|---|---|
| how | `send` hands the message to the daemon over the socket and returns at once | `send` opens its own short session |
| recipient online | delivered in about a second | delivered once the session is up (a few seconds) |
| recipient offline | **waits in the daemon's queue** (on disk, survives a restart) and goes out by itself when the recipient is back | **is lost** (a notice says so on stderr) |

In the **chat client** (`onchato-cli chat`), a message to someone who has left immediately gets
„nie doręczono … wyślę sama, gdy wróci” ("not delivered … will send it myself when they're back"): the client keeps it in memory and sends it when
the person returns, and then prints „wiadomość … dotarła jednak do ewa (po 2 min)” ("message … reached ewa after all (after 2 min)"). That
memory lives only until the client is closed. **Only the daemon has a persistent queue** — a
deliberate split: whether messages wait on disk is decided by the admin by running
the daemon (convenience at the cost of the content sitting encrypted at the sender), not by the chat
client behind the user's back.

`--json` result: `{"ok":true,"status":"delivered","id":"…","ms":412,"to":"ewa","via":"daemon"}`
(`status` = `delivered` or `queued`, `via` = `daemon` or `direct`).

**To a group** — the group name instead of a contact: `onchato-cli send zespol "deploy OK"`. A group
does not confirm delivery, so the result is `status: "sent"` and code `0`, with no queue: what is
sent goes straight to the members who are on the network. `--key` and `--ttl` do not apply
to groups.

### Receiving

```sh
onchato-cli listen                       # 22:41 <ewa> restart nginx?
onchato-cli listen --json | jq -c 'select(.t=="msg")'
```

JSON events (one line = one event):

```json
{"t":"msg","from":"ewa","pub":"…","text":"restart nginx?","ts":1791400121000,"id":"…"}
{"t":"msg","group":"zespol","from":"ewa","pub":"…","text":"deploy?","ts":1791400125000,"id":"…"}
{"t":"group","name":"zespol","members":3,"how":"invite"}
{"t":"presence","from":"ewa","pub":"…","state":"online"}
{"t":"delivered","to":"ewa","id":"…","ms":412}
{"t":"link","state":"reconnecting"}
```

With the daemon running, `listen` attaches to it; without the daemon it opens its own session.

### Daemon

```sh
onchato-cli daemon --profile ops-bot     # in the foreground; stop with Ctrl+C / SIGTERM
```

The daemon keeps the connection, contact presence and open conversations, and answers on the
local socket `$XDG_RUNTIME_DIR/onchato.sock` (mode `0600` — the socket is its entire
authentication, so nobody but you can use it). A second daemon
cannot be started on the same socket.

The daemon also listens on your invites and knocks on other people's (section 5). Contacts added
with `onchato-cli add` or accepted with `onchato-cli accept` work at once —
no need to restart the daemon.

An example systemd (user) unit, with the password passed through `LoadCredential` — not
in the unit file and not in an environment variable:

```ini
# ~/.config/systemd/user/onchato.service
[Unit]
Description=onchato-cli daemon (ops-bot)
After=network-online.target

[Service]
ExecStart=%h/.local/bin/onchato-cli daemon --profile ops-bot
LoadCredential=onchato-password:%h/.config/onchato/ops-bot.pass
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
install -m 600 /dev/stdin ~/.config/onchato/ops-bot.pass <<< 'ops-bot profile password'
systemctl --user daemon-reload
systemctl --user enable --now onchato
loginctl enable-linger $USER          # so the daemon runs without a logged-in session too
```

Example — a notification on SSH login:

```sh
# /etc/pam.d/sshd
session optional pam_exec.so /usr/local/bin/onchato-login-notify

# /usr/local/bin/onchato-login-notify   (runs as root - point it at the bot daemon's socket)
#!/bin/sh
[ "$PAM_TYPE" = open_session ] || exit 0
# root has no ~/.local/bin in PATH - full path; root connects to another user's 0600 socket
ONCHATO_SOCKET=/run/user/1000/onchato.sock /home/bot/.local/bin/onchato-cli send admin "login: $PAM_USER z $PAM_RHOST na $(hostname)"
# or, when the daemon is in a container (section 1, "Docker"):
# docker exec onchato onchato-cli send admin "login: $PAM_USER z $PAM_RHOST na $(hostname)"
```

### Files

A file is encrypted on your computer with a fresh key (AES-GCM, in chunks),
the encrypted content goes to the store, and the key, name and type travel only in the conversation.
The store sees only encrypted bytes and their size — and keeps them for **about 5 minutes**.
The size limit is 128 MB — that is the store's limit. Direct transfer (up to 512 MB,
straight to the other browser over WebRTC) exists only in the app; the terminal does not have it.

In the client:

```
/send ~/raporty/q3.pdf
22:41 <ewa> 📎 logi.tar.gz (2.4 MB) - /get rMS5
/get rMS5            # or just /get: the last file in this window
22:41 -!- zapisano /home/ala/Pobrane/logi.tar.gz
```

In scripts:

```sh
onchato-cli send-file ewa ./backup.log           # 0 = delivered, 3 = not confirmed in time
onchato-cli listen --json --save-files ~/przyjete   # every incoming file saved at once
onchato-cli get rMS5 --dir ~/przyjete            # save a file the daemon received
```

- Files are saved to `$ONCHATO_DOWNLOADS`, or without it to `~/Pobrane` or `~/Downloads`.
- Saving is safe: directories and control characters are stripped from the name (nothing lands
  outside the target directory), an existing file is **never overwritten** (you get
  `name (2).ext`), and the new file has mode `0600`.
- Files **do not wait in the daemon's queue** — the store deletes them after about 5 minutes anyway.
  To someone offline, `send-file` ends with code `3`.
- The `file` event in `listen --json` does not contain the key — only the process
  that received the file knows the key (the daemon or `listen` itself).

### Notification queue

The network stores nothing, so a notification for someone who is offline waits
**at the bot** — in the daemon's queue, encrypted on disk (it survives a restart of the daemon
and of the server). It goes out by itself when the recipient comes online.

```sh
onchato-cli send admin "login: $PAM_USER z $PAM_RHOST" --key ssh --ttl 24h
onchato-cli queue                        # what is waiting and for whom (--json for scripts)
```

| rule | how it works |
|---|---|
| **order** | oldest first, separately for each recipient |
| **lifetime** `--ttl` | 24 h by default (`30m`, `24h`, `7d`); an expired notification **is not sent late** — it is dropped, and the daemon records that in its log |
| **merging** `--key` | a waiting notification with the same key is replaced by the newest one, with the suffix „(+N wcześniejszych)” ("(+N earlier)") |
| **key window** | while the recipient is online, at most one notification per key goes out per minute; the rest wait and merge into the next — an SSH attack will not turn into 500 notifications |
| **limit** | up to 100 waiting per recipient; beyond that the oldest is dropped (with a log entry) |

`send` through the daemon returns `status`: `delivered` (delivered, code 0), `queued`
(waiting in the queue, code 3) or `merged` (merged with a waiting one, code 3). A notification
with a key sent during its window also has status `queued`, even when the recipient is online.

Without the daemon there is no queue: `--key` and `--ttl` then change nothing.

---

## 9. Command reference

| command | description |
|---|---|
| `onchato-cli profile new <name>` | new software profile |
| `onchato-cli profile list` | profiles on this computer |
| `onchato-cli profile import <file.ocmig>` | a profile moved from the app |
| `onchato-cli profile export <name> <file.ocmig>` | a profile to move to the app |
| `onchato-cli hem new <name> --hem <url>` | new identity on the HEM (with confirmation) |
| `onchato-cli whoami` | identity, key, fingerprint |
| `onchato-cli pubkey` | the bare public key (for scripts) |
| `onchato-cli contacts` | contacts with fingerprints |
| `onchato-cli add <link\|code> [--name n] [--yes] [--note text]` | a contact from a link; for a mailbox invite — knocks (`--note` attaches a short note) |
| `onchato-cli add <name> <keyB64>` | a contact from a raw key |
| `onchato-cli invite [--qr]` | your identity link (and QR code) |
| `onchato-cli invites` · `invites new [label] [--expires 24h] [--qr]` · `invites qr <no>` · `invites revoke <no>` | mailbox invites |
| `onchato-cli verify <name> [--qr] [number]` | safety number; compare with the one given |
| `onchato-cli chat [<name>] [--debug]` | chat client |
| `onchato-cli send <contact\|group> <text \| -> [--wait s] [--ttl 24h] [--key k] [--json]` | a single message (section 8) |
| `onchato-cli queue [--json]` | what is waiting in the daemon's queue |
| `onchato-cli send-file <contact> <file> [--wait s] [--json]` | a file (the store keeps it about 5 min) |
| `onchato-cli listen [--json] [--save-files <dir>]` | with `--save-files` saves incoming files at once |
| `onchato-cli get <id> [--dir <dir>]` | save a file received by the daemon |
| `onchato-cli daemon` | daemon with a local socket |
| `onchato-cli knocks` · `accept <no>` · `ignore <no>` | knocks on your invites, through the daemon |

### Exit codes

| code | meaning |
|---|---|
| `0` | OK |
| `1` | error (message on stderr: wrong password, no such contact, no terminal…) |
| `3` | `send`: not delivered in time — waiting in the daemon's queue (or merged with a waiting one); without the daemon it is lost (section 8) |
| `4` | `verify`: the numbers do **not** match |
| `130` | interrupted with Ctrl+C at the password prompt |

---

## 10. Options and environment variables

| option / variable | effect |
|---|---|
| `--profile <name>` | which software profile |
| `--hem <url>` | identity from a HEM instead of a profile |
| `--handle <name>` | which identity on the HEM (without asking) |
| `--password <password>` / `ONCHATO_PASSWORD` | password without a prompt — note: visible in the shell history and the process list; in scripts prefer the variable or the prompt |
| `--password-file <file>` | password from the file's first line (`0600`); under systemd use `LoadCredential=onchato-password:…` instead |
| `--yes` | no t/N question (scripts) |
| `--wait <s>`, `--json` | `send`: how long to wait for the confirmation; result as JSON |
| `--ttl <time>`, `--key <key>` | `send` through the daemon: lifetime in the queue; merge key for repeated events |
| `ONCHATO_SOCKET` | daemon socket (default `$XDG_RUNTIME_DIR/onchato.sock`) |
| `ONCHATO_DOWNLOADS` | where to save files (default `~/Pobrane` or `~/Downloads`) |
| `--debug` | in the client: engine log in the status window |
| `--libp2p` | in the client: full GossipSub transport instead of the light one (diagnostics) |
| `--network <id>` | the network this run works in: by default the chosen profile's (a profile cannot be moved to another network), else `main`. For a HEM identity it names the network on its first sign-in. An id this device does not know is, as before, the built-in nodes under another id - for development. Clients on different ids never meet, even on the same node |
| `--access-code <8 digits>` | a network that admits devices by list: the administrator's code, the first time this device runs in it (`ONCHATO_ACCESS_CODE` in a script); `--device-name` names the device for the administrator |
| `--network-profile <file\|link>` | `profile new`: make the profile in another operator's network, from its signed profile file or the short link with its CID |
| `ONCHATO_NETWORK_PROFILE` | the built-in network profile to use instead of `infra/network.json` (a build for another network) |
| `--core ts` | the EH‑2 handshake and the ratchet computed in the TypeScript engine instead of the `core-rs` module (Rust → WASM, `impl/core-wasm/core.wasm`), which is the default since 0.7.21. The same frames on the wire, so the other side sees no difference |
| `ONCHATO_HOME` | data directory (default `$XDG_CONFIG_HOME/onchato`, i.e. `~/.config/onchato`) |

Password without a terminal (a pipe): `onchato` reads the first line from standard input.

---

## 11. Where the data lives and how it is protected

Everything is in `~/.config/onchato/store.json` (directory `0700`, file `0600`,
written atomically). Keys and formats are the same as in the app, so
a profile moves both ways without conversion.

| what | how it is protected |
|---|---|
| identity (software profile) | sealed with your password (PBKDF2 1 000 000 rounds + AES-GCM); the private key is nowhere in the clear |
| contacts | sealed (AES-GCM with a key derived from the identity) — the file does not reveal whom you know, and a swapped contact is detected: `onchato-cli` neither uses nor overwrites a book that does not open |
| entry names in `store.json` | HMAC digests under the identity key — a name reveals neither a KID, nor a contact, nor a group |
| invites, knocks, the ignore list | encrypted with a key derived from the identity |
| conversation history | **there is none** — a conversation exists only on the participants' screens |

On a server a HEM is better: the key never leaves the device, and stealing the file gains nothing.

---

## 12. Limitations worth knowing

- **A conversation requires presence.** onchato does not store messages in the network. A message
  arrives when the other person is online; if they are not, it waits on your side while the client
  runs. Once the client is closed, nothing waits.
- **One identity, one session.** The same identity open at the same time in the app
  and in the terminal (or in two terminals) closes both sessions. To talk to yourself,
  use two different identities.
- **An invite listens only while the client or the daemon is running.** Without
  `onchato-cli chat` or `onchato-cli daemon` running, a knock has nowhere to go.
- **Files live about 5 minutes** in the store — whoever does not download them in that time has to ask
  for them to be sent again.
- **Not there yet**: scrolling back through window history (PgUp), a typing indicator, a direct
  connection (WebRTC) — in the terminal everything goes through the nodes. The order is in [CLI-PLAN.md](CLI-PLAN.md).

---

## 13. Troubleshooting

**Alt+digit does not switch windows.** Your terminal sends Alt differently (e.g. as an accented
character). Set "Meta sends Escape" in the terminal (GNOME Terminal, Konsole; iTerm2:
"Option as Meta") or use `/win N`.

**Knocks on an invite do not arrive.**
1. Is `onchato-cli chat` running, and does the status window show „słucham N zaproszeń” ("listening on N invites")? Or the daemon:
   the same line is in its log after startup.
2. Does that person already have you in their contacts? The app then does not knock — it shows
   „Ten sam klucz, który masz zapisany” ("The same key you have saved"). A knock from an existing contact is reported by the client
   in the status window as a single line.
3. The app retries the knock every 90 s — give it a moment.

**„złe hasło” ("wrong password") with a password you are sure of.** The password is per profile. Check `onchato-cli profile list`
and `--profile`.

**„książka kontaktów nie przeszła weryfikacji” ("the contact book failed verification").** Someone (or something) changed
`store.json` outside `onchato-cli`. Nothing is overwritten — it is evidence. Restore the
file from a backup. If you have a profile export (`.ocmig`), you can also set
`store.json` aside and import the profile again (`onchato-cli profile import`).
Entry names are HMAC digests, so a single book entry cannot be
identified by name.

**The terminal is left in a strange state** (e.g. after the process was killed): type `reset`.

**„ta tożsamość otworzyła się w drugim miejscu” ("this identity opened in another place").** You have the same identity open
in the app or in a second terminal — close one of them and start again.
