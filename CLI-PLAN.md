# The CLI as a product — for geeks and admins

Working notes, not a spec, like `EMBED-PLAN.md` and `MOBILE-PLAN.md`. Written
2026-10-07, when the user asked what state the CLI is in and decided it should
become a real client: an IRC-style terminal app (irssi is the model) plus a
scripting/daemon mode for administrators.

## Where it stands (2026-10-07)

`impl/cli/` — 561 lines, untouched since 2026-09-21. It works and it talks to
production (`npm run eh2-test` over the live relay: handshake + ratcheted
message, PASS). `node cli/ec.ts register|whoami|pubkey|add|contacts|chat`; one
conversation at a time, `/who /me /react /quit`, typing/away/leave, `--mqtt`.

Missing against the app: files (`/file` prints "not implemented"), groups,
invite links / QR / knocks (a contact is added by raw key only), the safety
number, several conversations and presence, the node list (bs1 is hard-coded,
no failover). The software keystore is a **test** store with the private key in
a plain file and is not the browser's sealed profile format — a profile
exported from the app cannot be used here. Today it is a developer tool.

## Progress

- **Stage 1 - done 2026-10-07.** `cli/onchato.ts` (`npm run onchato`) replaces
  `cli/ec.ts`: `profile new|list|import|export`, `whoami`, `pubkey`,
  `contacts`, `add`, `chat`; `--profile` / `--hem`; masked password prompt or
  `$ONCHATO_PASSWORD`. Storage `cli/store.ts` - the browser's `ec-*` keys in
  `~/.config/onchato/store.json` (0600, dir 0700, atomic writes). Profiles are
  the app's own sealed format (`cli/profiles.ts` over `lib/profile.ts`,
  `lib/migrate.ts`, `lib/passmeter.ts`); the signed contact book moved out of
  `app.ts` into `lib/localbook.ts`, shared by both. Pinned by
  `test/cli-profiles.test.ts`: a browser profile with contacts moves to the CLI
  and back with the same key and a signature that still checks, and a book
  edited behind the CLI's back is caught. The plaintext keystore remains only
  for the live test scripts (`bob`, `carl`).
- **Stage 2 - done 2026-10-07.** `invite [--qr]` prints the link
  (`app.onchato.com/#i=`) and draws the code in the terminal (`cli/termqr.ts`:
  lib/qr.ts's matrix in half blocks, forced dark-on-light, quiet zone);
  `add <link|code>` reads every shape through `inviteFromPaste` (moved from
  app.ts to lib/invite.ts, one parser for both), shows the fingerprint, asks
  (or `--yes`; refused without a terminal), and prints the reply link marked
  `r:1`; `verify <name> [--qr] [number]` shows the safety number
  (lib/safety.ts) and compares one read out - exit 0 match, 4 mismatch.
  Tested: the terminal QR rasterised back decodes to its text with the app's
  jsQR (and a swapped mapping does not); a screenshot of the real output
  decodes too.
- **Stage 3 - done 2026-10-07** (3a windows/keys/editor, 3b screen, 3c client).
  `onchato chat [<name>]` is the irssi-style client (`cli/client.ts`): one
  session over the published node list with failover (or the profile's own
  `ec-nodes`), light transport, a presence watch for every contact, an
  incoming conversation opening in a background window (told on status,
  `Act:` lit, the view not moved), `/win` Alt+N `/query` `/close` `/list` `/who`
  `/me` `/react` `/verify` `/invite` `/clear` `/help` `/quit`, the status line
  with link, node, the lock after EH-2 and activity. Proved live by
  `net/cli-client-test.ts`: two clients on emulated terminals over the real
  relays, every assertion read off the screen. Not yet: PgUp scrollback,
  typing indicators, files (stage 5), group windows (stage 6).
- **Stage 2b - done 2026-10-07: invites that answer themselves** (asked the
  same day). `onchato invites [new [label] [--expires 24h] [--qr] | qr N |
  revoke N]` keeps the app's sealed records (`ec-invites-`, `ec-waiting-`,
  `ec-ignored-<kid>`, via the new `lib/sealedstore.ts`, which the app now
  uses too), so invites move with the profile. The client listens on every
  live invite: a knock lands on status, loud, with the fingerprint -
  `/knocks`, `/accept N` (adds the contact), `/ignore N` (by fingerprint,
  as the app). `add <invite with an inbox>` really knocks and leaves the
  waiting record; the client keeps knocking every 90 s until the other side
  announces, then says so. Input lines now run in order, so a message typed
  right after `/query` waits for the window. Proved live by
  `net/cli-invite-test.ts` (CLI to CLI over the real relays).
- **Stage 4 - done 2026-10-08.** `cli/hub.ts` (headless engine: one session,
  presence, rooms on demand, events, `send` that waits for the recipient's ack),
  `cli/daemon.ts` (the hub behind `$XDG_RUNTIME_DIR/onchato.sock`, 0600, JSON
  lines; a live daemon is never displaced, a stale socket is), commands
  `send` (exit 0 delivered / 3 queued; through the daemon if one runs, else
  its own short session), `listen [--json]`, `daemon`; passwords from
  `--password-file` or systemd `LoadCredential`. Proved live by
  `net/cli-daemon-test.ts`: delivered through the socket, a listen stream,
  `onchato send` as a process via the daemon and without one, and a send to an
  offline recipient that reaches him by itself when he is back.
- **Stage 4b - done 2026-10-08: the notification queue.** `cli/outbox.ts` (the
  rules, pure: oldest first, TTL - expired entries dropped and reported, never
  late - merging by `--key` with "(+N wcześniejszych)", one message per key per
  60 s window while online, 100 per recipient, oldest out) and `cli/queue.ts`
  (sealed to `ec-outbox-<kid>`, flushed when presence lights and every 30 s;
  a message handed to a room but not yet confirmed is tracked by its id, not
  sent twice; an entry only waiting for its key's window does not hold up
  others). `send --ttl --key`, `onchato queue`. Proved live by
  `net/cli-queue-test.ts`: merging while offline, a TTL expiry, the queue
  surviving a daemon restart, delivery by itself when bob comes online
  (merged, in order), the per-key window while online.
- **Stage 5 - done 2026-10-08: files.** `cli/files.ts` over the app's own
  pieces (lib/filecrypto.ts, lib/fileenvelope.ts, net/ipfs.ts with the store
  at onchato.com): a fresh key per file, chunked AES-GCM, the ciphertext to the
  store, CID and key only inside the conversation; saving never leaves the
  download directory, never overwrites, writes 0600, refuses an expired file
  before fetching and says so for a wrong key. Client `/send`, `/get [id]`;
  scripts `send-file`, `listen --save-files`, `get` (daemon). Files do not
  queue (the store sweeps in ~5 min). Proved live by `net/cli-files-test.ts`
  (client to client, through the daemon, and listen --save-files - all byte
  for byte; the event carries no key).
- **Stage 6 - done 2026-10-08: groups.** `cli/groups.ts` is app.ts's group
  orchestration for a terminal, over lib/group.ts: an invitation joins and we
  hand our key to every member once (the admin's receipt), a newer epoch
  reopens and redistributes, the name changes only from roster[0], key
  requests are answered only for roster members, unreadable frames ask the
  sender, an admin's invitations are owed (groupview.ts OwedInvites) and
  re-sent when the member is online; sealed in the app's format
  (`ec-gcache-<kid>-<gid>`, {snap, name, owed}). Client: group windows,
  `/group new`, `/groups`, `/who` (admin, outside contacts, owed), `/send` to a
  group, `@Name` mentions (closeMentions out, mentionsPub/resolveMention in -
  a mention lights the status line louder). A 1:1 opened only to carry group
  keys gets a window when there is something to show, not before. Proved live
  by `net/cli-group-test.ts` (three CLI clients: create, join by themselves,
  messages from each member, a mention, /who, a restart restoring the group).
  Then (2026-10-08) the admin's side and scripts: `/add` `/kick` (a rekey -
  new epoch, keys only to the new roster) and `/rename` (same-epoch handoff,
  markers rewritten); the Hub runs the same Groups, so `onchato send <group>`
  goes through the daemon (status `sent`, a group has no acks, never queued)
  and `listen` carries `group` on msg/file events. Owed invitations are also
  re-sent 10/30/90 s after they go out: a `group-skd` has no ack, and one sent
  on a 1:1 the distribution itself opened can beat msg3 to the member and be
  dropped there (found by the test, a few runs in ten); a member's own key,
  handed out on joining, meets the same race and goes twice more (10/30 s).
  Group state is now saved as the app saves it - at once after our own send,
  on a 1.5 s debounce after a receive: saved only on roster changes, a
  restart resumed the sending chain from an older counter and the members
  read nothing (cli-group-test's restart step). A refused SKD is
  logged in lib/core.ts instead of rejecting unhandled, which in Node ended
  the process. Proved live by `net/cli-group-admin-test.ts` (two terminals +
  a script behind the daemon: add, script send, kick locks bob out, rename).
  Known, shared with the app: a frame that beats its sender's key is dropped,
  not held (lib/group.ts asks for the key; the next frame opens).
- **HEM**: sign-in never creates an identity (`onchato hem new <name>` does),
  and several identities on one device are offered as a numbered list.

## Principles

- **Same engine, same network.** Another consumer of `lib/core.ts`, like the
  app. It talks to every app user; there is no CLI protocol.
- **Two modes:** interactive (irssi-like windows) for people; scripting (JSON
  lines, exit codes, a daemon) for admins and bots.
- **An identity on a server is serious.** HEM recommended. A software profile
  only sealed with a password, in the browser's format (§4.5), files `0600`.
  The plaintext test keystore goes.
- **Instant-only, said plainly.** Nothing stores messages for the absent
  (PROTOCOL.md). A script reaches a human who is online, or one who comes
  online **while the daemon still runs** — that is what the daemon is for.
  Fire-and-forget to somebody offline does not work, by design.
- **No voice recording** in the terminal (user's call). Files: yes.

## The interactive client — what it looks like

One terminal, windows like irssi (also fine inside `screen`/`tmux`, over SSH).
Plain ANSI: a scrolling area and a fixed status line, no heavy TUI library.

```
22:39 <vostro1> cześć, testujesz CLI?
22:39 <ala> tak, z terminala przez ssh na serwerze
22:40 <ala> /verify
22:40 -!- Numer bezpieczeństwa (porównajcie):
            38421 99404 36991 55408
            98720 49421 91348 03686
            18393 31929 19411 95686
22:41 -!- plik od vostro1: raport-q3.pdf (1.2 MB) — /get 7f3a
22:42 -!- wysłano nginx-error.log (84 kB) · doręczono
[22:42] [ala·HEM] [bs1 ●] [2:vostro1 🔐] [Act: 3,4]
[vostro1] /send ~/logs/nginx-error.log
```

- Window `1` is status (start-up, invites, presence); `2..n` are 1:1s and groups.
- `/win N` or **Alt+1…9**; `/query <contact>` opens a window, `/close` shuts it.
- The status line: time, identity (HEM / software), node and link state, the
  current window, and `Act:` — windows with activity, a mention highlighted
  harder than a plain message.
- `/list` (contacts with ●/○/?, window, fingerprint prefix), `/who`, `/me`,
  `/react`, `/verify` (safety number, `lib/safety.ts`), `/invite` (own link;
  `--qr` draws the code in the terminal with `lib/qr.ts`), `/send <path>`,
  `/get <id>`.
- Groups: the same windows, mentions, and the "outside your contacts" warning
  the app shows (`web/src/groupview.ts` logic is reusable as is).

Scripting:

```
$ onchato send ops-oncall "dysk 92% na db1"      # exit 0: delivered
$ onchato send antek3a "backup gotowy"           # exit 3: offline, waits (daemon)
$ onchato listen --json | jq -c 'select(.t=="msg")'
$ systemctl --user status onchato                # the daemon, its own profile
```

The rendered mockup of all four views was shown to the user on 2026-10-07 and
accepted.

## The bot / notifier (decided 2026-10-07)

The CLI also runs as a **notifier**: a system event becomes a message to an
admin or a group. The motivating case is a login alert:

```
# /etc/pam.d/sshd
session optional pam_exec.so /usr/local/bin/onchato-login-notify

# /usr/local/bin/onchato-login-notify
onchato send admin "login: $PAM_USER z $PAM_RHOST na $(hostname)"
```

The same hook fits cron, `systemd OnFailure=`, a monitoring alarm, or a
`journalctl -f` filter. What it takes beyond plain `send`:

1. **`send` goes through the daemon.** A stand-alone `send` would dial the
   relay and run EH-2 with the recipient every time — 1–3 s, more with a HEM.
   The daemon holds the sessions; `send` hands it the message over a local
   socket (`$XDG_RUNTIME_DIR/onchato.sock`, `0600`) and returns at once.
2. **A queue that waits for the recipient to be online** — the core of the
   feature. The network stores nothing (PROTOCOL.md), so a notification for an
   absent admin waits **on the bot's side**:
   - an outbox **sealed to a file** (§10 cache key), so a daemon restart or a
     reboot does not lose it;
   - delivered the moment the recipient's presence lights and the 1:1 is up
     (the same trigger the app uses for parked messages and owed group
     invitations), confirmed by the ordinary `ack`;
   - **oldest first**, each with a **time-to-live** (default 24 h, per message
     `--ttl`): a login alert from yesterday is noise, not news, and is dropped
     with a line in the bot's own log;
   - a size cap per recipient, so an absent admin cannot make the bot grow
     without bound;
   - `onchato queue` lists what waits and for whom; `send` returns exit `3`
     ("queued") when the recipient is not online right now, `0` when delivered.
3. **Coalescing.** A brute-force run is hundreds of failed logins a minute.
   Messages with the same `--key` inside a window merge into one ("12 failed
   logins from 1.2.3.4 in 5 min"), and a queued message is updated in place
   rather than appended.
4. **A group as a channel.** The bot posts to a group ("ops") and every admin
   gets it; the group rules hold — the bot and all members are mutual contacts.
5. **The bot's identity.** Its own profile. Unlocked at start with
   `systemd-creds` or a `0600` key file; a HEM is safer and needs the device.
   The bot is an ordinary contact: added by invite, verified by safety number.

**What it cannot do, said plainly:** a notification arrives when the recipient
is online, or comes online within the TTL while the bot runs. There is no push
to a sleeping phone (no Google/Apple servers). Android keeps the app alive with
a foreground service, so in practice it usually arrives; an iPhone with the
screen off does not receive it until the app is opened again — a product fact.

**Commands TO the bot** (`/status` from an admin) are possible and dangerous: a
command from a chat run on a server is a remote shell. If ever built: an
allow-list of named commands, only from verified contacts. Separate stage,
optional, not scheduled.

## Stages

Working days for one person who knows the code; a judgement, not a measurement.

| # | Stage | Delivers | Days |
|---|---|---|---:|
| 1 | **Foundation** | npm package with an `onchato` command (`npx onchato`), `~/.config/onchato`, the sealed profile in the browser's format, import/export of the app's profile file, HEM sign-in | 2–3 |
| 2 | **Contacts and invites** | `/invite` (link + terminal QR), `add <link>` (`#i=`), `/verify` (safety number) | 2 |
| 3 | **irssi-style client** | one transport, many rooms; windows, Alt+N, status line with activity; `/list` with presence; the node list (`nodes.json` / CID) with failover | 4–5 |
| 4 | **Scripting and daemon** | `send`, `listen --json`, exit codes, `--daemon` + a systemd unit; parked messages leave when the recipient returns | 2–3 |
| 4b | **Bot / notifier** | `send` through the daemon socket; the sealed outbox that waits for the recipient (TTL, cap, oldest first, `queue`); coalescing by `--key`; a group as a channel; the PAM login example | 3–4 |
| 5 | **Files** | `/send`, `/get` through the same encrypted store as the app; voice notes download only | 2 |
| 6 | **Groups** | create, list, join, group windows; owed invitations and group state sealed to a file (§10) | 3–4 |
| 7 | **Packaging and tests** | npm publish, a Docker image for servers, README / `--help`, a CLI ↔ browser scenario in the harness | 2–3 |
| 8 | **Direct connection (WebRTC), opt-in** | `node-datachannel` as an OPTIONAL dependency behind the `makeLink` seam of `net/webrtc-plane.ts` (as the Linux desktop plugs webrtc-rs); `--direct` in the client and the daemon. Off by default, as in the app: the default hides the IP from the other side (the user's call, 2026-10-08 - kept after WebRTC became reliable). Without the library everything goes through the nodes, as today | 2–3 |

**Total ≈ 20–26 days**, plus 2–3 for stage 8. Stages 3, 4b and 6 carry the spread.

Stages 1–2 are the best value: a usable client for one geek and one contact.
Stages 4 and 4b are the admin argument — monitoring and bots as their own identity, with notifications that wait for the admin.

## Order and dependencies

Shared with `EMBED-PLAN.md`: the `@encedo/chat-core` package and the **protocol
compatibility rule** (a version on the wire, a visible "the other side runs an
older version"). The rule comes **before** the first npm publish of the CLI —
an installed CLI stays on its version far longer than an app that updates
itself, and a silent incompatibility looks like an outage.

After 0.7.0: compatibility rule → `chat-core` → CLI stages 1–2 → Open Mercato
PR → CLI stages 3–7 (4b right after 4).

## Deliberately out

- A full-screen TUI with panes — the irssi model is enough.
- Recording voice notes.
