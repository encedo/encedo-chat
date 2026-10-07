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

## Stages

Working days for one person who knows the code; a judgement, not a measurement.

| # | Stage | Delivers | Days |
|---|---|---|---:|
| 1 | **Foundation** | npm package with an `onchato` command (`npx onchato`), `~/.config/onchato`, the sealed profile in the browser's format, import/export of the app's profile file, HEM sign-in | 2–3 |
| 2 | **Contacts and invites** | `/invite` (link + terminal QR), `add <link>` (`#i=`), `/verify` (safety number) | 2 |
| 3 | **irssi-style client** | one transport, many rooms; windows, Alt+N, status line with activity; `/list` with presence; the node list (`nodes.json` / CID) with failover | 4–5 |
| 4 | **Scripting and daemon** | `send`, `listen --json`, exit codes, `--daemon` + a systemd unit; parked messages leave when the recipient returns | 2–3 |
| 5 | **Files** | `/send`, `/get` through the same encrypted store as the app; voice notes download only | 2 |
| 6 | **Groups** | create, list, join, group windows; owed invitations and group state sealed to a file (§10) | 3–4 |
| 7 | **Packaging and tests** | npm publish, a Docker image for servers, README / `--help`, a CLI ↔ browser scenario in the harness | 2–3 |

**Total ≈ 17–22 days.** Stages 3 and 6 carry the spread.

Stages 1–2 are the best value: a usable client for one geek and one contact.
Stage 4 is the admin argument — monitoring and bots as their own identity.

## Order and dependencies

Shared with `EMBED-PLAN.md`: the `@encedo/chat-core` package and the **protocol
compatibility rule** (a version on the wire, a visible "the other side runs an
older version"). The rule comes **before** the first npm publish of the CLI —
an installed CLI stays on its version far longer than an app that updates
itself, and a silent incompatibility looks like an outage.

After 0.7.0: compatibility rule → `chat-core` → CLI stages 1–2 → Open Mercato
PR → CLI stages 3–7.

## Deliberately out

- A full-screen TUI with panes — the irssi model is enough.
- Recording voice notes.
