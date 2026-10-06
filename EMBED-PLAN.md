# Embedding the chat inside someone else's application

Working notes, not a spec. `docs/` stays the audit target; this file is
implementation reality, like `CLAUDE.md`, `GROUPS-DESIGN.md` and
`MOBILE-PLAN.md`.

Written 2026-08-07, prompted by a concrete case: a software vendor who does not
want to write a chat and does not want to ship a second application, and would
rather embed ours — specifically as a module for
[Open Mercato](https://github.com/open-mercato/open-mercato), a modular CRM/ERP
framework whose features arrive as npm packages (`@open-mercato/*`) hooked in
through declared extension points, never by patching the core.

The short version: **embedding the widget is the easy part.** Three questions
underneath it decide whether the result is a product or a misunderstanding, and
one of them is a straight conflict with what this chat is.

---

## What is already true — measured, not assumed

- **The core does not touch the DOM.** `lib/` and `net/` contain no `document.`
  and no `window.` (the single grep hit in `room.ts` is the word "window" in a
  comment). The two exceptions are `net/browser-test.ts` and
  `net/phone-shot.ts`, which are harnesses, not shipped code.
- **Storage is injected, not reached for.** Two direct `localStorage` uses in
  the core: the capability probe in `lib/capabilities.ts` (feature detection,
  correct) and `lib/migrate.ts`'s `localKV` (the profile-export path). Everything
  else takes storage as a parameter — `localContactBook(load, save)`, the group
  cache, the sealed profile.
- **There is one named facade already**: `startSession`, `session.open`,
  `openConversation`, `Identity`, `ContactManager` (`lib/core.ts`). The CLI, the
  web GUI and the test harnesses are three consumers of it today, which is the
  useful evidence — an interface with one caller proves nothing.

So "headless core, UI as a replaceable module" is not an aspiration in this
repo; it is the current state. **`@encedo/chat-core` could be published with no
architectural work at all.**

## What is not a component yet

The UI. `web/src/app.ts` is **9403 lines** (re-measured 2026-10-06; 2748 when
this plan was priced, ~5800 on 2026-08-30 — **it has more than tripled**, so
every estimate keyed to it is a lower bound) that assume they *are* the page:

| what | 2026-08-30 | 2026-10-06 | why it blocks embedding |
|---|---:|---:|---|
| `document.*` | ~129 | 211 | queries the whole document, not a subtree it owns |
| listeners bound at module scope | ~80 | more | **importing the module runs the app**, and requires the ids to already exist |
| direct `localStorage` | ~57 | 64 | `ec-*` keys are global to the origin: no namespace, collides with a second instance |
| module-level singletons | well past 10 (`session`, `rooms`, `activePub`, …) | one instance per page, by construction |
| CSS | in `index.html` `<style>` | would leak both ways between us and the host page |

There is also no teardown: nothing closes the libp2p node when the surrounding
view goes away.

None of this is subtle or risky work. It is, however, real work, and it is
spread across the largest file in the repo.

## Three shapes, and what each actually costs

### A. An iframe with a `postMessage` bridge

Fastest to ship, and **the only shape that keeps the keys away from the host**:
a different origin means the host's JavaScript cannot read our storage or our
DOM. That is not a detail for a product whose claim is end-to-end encryption.

Costs: browser storage partitioning gives an embedded third-party frame its
**own** storage bucket, so the identity inside the host application is a
different identity from the one on onchato.com — and on Safari it may need the
Storage Access API before it has any storage at all. Appearance is limited to
whatever the bridge exposes.

### B. An npm component (`<encedo-chat>` + Shadow DOM)

This is the shape Open Mercato's module system wants: a package that contributes
UI through widget injection. Native look, one origin, ordinary integration.

The cost has to be stated in one sentence and not buried: **any code on the host
page can read the identity and the plaintext.** The security boundary is gone,
while the product still *looks* end-to-end encrypted. For an in-house
deployment that may be an acceptable trade — the host application is the same
company's code. For a hostile-host threat model it is not a trade at all.

### C. Core only — they write the UI

Least work here, most work there, and the interface (`lib/core.ts`) is the piece
that is genuinely ready.

**Recommendation: B as the product, with `@encedo/chat-core` published
separately, and A kept as the same package in a different mode** for anyone who
cannot accept the host reading the keys.

**Order revised 2026-10-06:** A first, as the Open Mercato PR, and B only if A
earns it — see *Sequence as of 2026-10-06* below.

## What has to change on our side, in order

1. **`mount(root, opts)` / `destroy()`** instead of import-time side effects;
   state moves from module scope onto an instance. This is the large item, and
   the other five are small next to it.
2. **Shadow DOM**, with the stylesheet moved out of `index.html` into the
   component.
3. **Injected storage in the UI too** — the 33 direct uses — with a namespace,
   so two instances and the host cannot tread on each other's keys.
4. **Locale from the host.** `i18n.ts` already supports the switch; what is
   missing is the entry point.
5. **Lazy loading.** The bundle is ~1.6 MB minified (2026-10-06; 1.32 MiB on 2026-08-30). In someone
   else's application it must load when the chat is opened, not when the page is.
6. **Teardown on unmount**, including the libp2p node and every open room.

A sketch of the surface, to be argued with rather than accepted:

```ts
const chat = await mount(element, {
  identity: { kind: 'software', profile: 'anna', unlock: askUserForPassword },
  storage: namespacedStorage('mercato-chat'),
  locale: 'pl',
  nodes: [...],                    // relay list; defaults to the published one
  onUnread: (n) => badge(n),
})
chat.openWith(peerPublicKey)       // discovery is the host's job — see below
chat.destroy()
```

## Three questions that are harder than the UI

### a) There are no offline messages, and that is a design decision

This chat is instant-only: no server-side storage, no store-and-forward, no
delivery to somebody who was not there. In a CRM or an ERP, a user writes to a
colleague who is away and **expects the message to arrive**. That expectation is
not a missing feature on our side; it is the opposite of what the architecture
promises, and the reason there is no operator-held message store to subpoena,
leak or lose.

**This has to be answered before any code is written.** If their users need
messages to survive the recipient being offline, embedding the widget is the
smallest of the problems — the product does not fit the use case, and no amount
of integration work changes that.

### b) Discovery needs a directory, and we deliberately do not have one

A pair's topic is derived from `ECDH(IK_a, IK_b)`, so a conversation is only
reachable once **both** sides hold each other's public key. There is no lookup
service by design: a directory of who can talk to whom is precisely the social
graph this architecture refuses to hold.

A CRM wants "message this user" by their own user id. The only place that
mapping can live is **the host** — they already have the user list. That is
workable, and the consequence must be said out loud rather than discovered
later: **the host's server can substitute a key and become a man in the
middle.**

What makes it survivable is already built: the fingerprint comparison in the
import dialog, treating the first key seen for a contact as pinned, and — since
0.6.45 — the pair's **safety number** with a QR scan (PROTOCOL.md §4.4.1), one
string both people see identically. A substituted key then becomes
*detectable* by anyone who checks — not *impossible*. Anything that hides the
safety number to make the integration smoother throws away the only defence
there is.

**The directory is a convenience, not a protocol requirement** (discussed
2026-10-06). Someone has to tell Anna that Bartek's key is X; there are three
ways, and the module should offer the first and third:

1. **A person, no server** — invite link, live QR, a published invite with a
   knock (§5.7), exactly as onchato works today. Nothing in the middle to
   substitute; the cost is friction (every pair exchanges keys once).
2. **An administrator through the HEM** — enrolling colleagues' keys into each
   user's HEM contacts (§2.3 "admin enrollment"). No directory server, but a
   trusted person.
3. **A column in the host's user table** — not a new server: the ERP already
   has the users. The client publishes its public key there on first sign-in
   and reads a colleague's on "message Bartek". Best UX, and the database
   operator can attempt a substitution.

Recommended: 3 for convenience, with what makes it honest — **the first key
is pinned** and a different one later is shown loudly, never switched to
silently (*to build*: a key-change warning; today a new key is simply a new
contact); the safety number checks the directory at any time; 1 stays
available. The directory only suggests whom to start with; trust still rests
on the keys and the check.

### c) One identity, one session (§9.1)

A user with the chat open inside the host application **and** onchato.com open
in another tab is a duplicate identity, and both sessions stand down by design.
This will happen during their first afternoon of testing and will look exactly
like a bug.

## What the host has to provide

- **CSP**: `connect-src` must allow the relay (`wss://bs1.onchato.com`, and any
  other node in the list). If files are enabled, the upload proxy too.
- **CORS on the HEM**, for HEM identities: the device has to accept their origin.
- **A key directory endpoint**, per (b) — their user id → our public key, plus
  somewhere to publish their users' own keys.
- **A file store**, if files are wanted: an IPFS node behind a two-endpoint
  proxy, as in `infra/README.md`. Uploads expire in minutes by design; a CRM may
  well want the opposite, which is the same conversation as (a).

## Product value — revisited 2026-10-06

Asked before any code: is a Node module plus a cut-up app worth it for **us**,
not only for Open Mercato? Two decisions with very different balances.

**`@encedo/chat-core` — yes.** It is a B2B channel, and every product that
embeds the chat embeds HEM support with it, which sells devices, not only
reach. It enables integrations without us (bots, system notifications as a
separate identity, other runtimes), gives the cryptographer a clearly bounded
unit with a public API, and costs 2–3 days.

The real cost is that a published API is a contract while the protocol still
moves (§5.4 rooms moving in place and §7.4 albums changed this month; the
review is open). An app pinned to an old core stops seeing the network after a
protocol change, and it looks like an outage. **Prerequisite, before
publishing: a compatibility rule** — a protocol version on the wire and a
clear "the other side runs an older version" instead of silence.

**Componentising `app.ts` — not as a big project.** Three to five weeks at
today's size, with regression risk landing just before 0.7.0 and the first
external demos. Its value to us (a file that can be tested and maintained) is
real but can be collected incrementally: extract what a change touches anyway
(the connection and security windows of 0.6.43–0.6.45 are natural first
modules). `mount()` waits until somebody actually needs the component.

**What this means for Open Mercato.** Their model is: we propose and open a
PR (confirmed 2026-10-06). The first PR needs no app refactor — an OM module
that embeds the chat in an **iframe** (postMessage bridge, a public-key column
per user, CSP), pointing at our static build hosted by us or by them. On our
side: a small `embed` page plus the compatibility rule.

## One rule that must not be broken

**One protocol, one build, everybody.** Rendezvous, the per-pair rotation offset
and the group epoch schedule all assume both ends run the same scheme; a fork
"just for the embedded build" produces two populations that cannot see each
other and would be discovered as an outage. Whatever ships as a component ships
from this repo, at this version.

## Open decisions

Ours:

1. B or A first — i.e. do we accept a host-readable identity as the default
   shape, and document it, or lead with the iframe?
2. Does `mount()` land in this repo's `web/src/`, or does the UI move into its
   own package with the web app as its first consumer?

Settled 2026-10-06: the host is Open Mercato, and the way in is a PR to their
repository. The directory is option 3 above with pinning and the safety number.

Theirs, and (a) blocks everything:

3. Do their users accept instant-only messaging?
4. Who runs the key directory, and do they accept that its operator can attempt
   a substitution that the fingerprint makes visible?
5. HEM identities, software profiles, or both?

## Stages, complexity and time

Working days for one person who knows this codebase. They are a judgement, not a
measurement, and they are worth exactly as much as that — **stage 2 exists to
replace stage 3's number with a real one.** Stages 1 and 2 are independent of the
answer to (a) and can start today; from stage 3 on, nothing should start before
it.

| # | Stage | Complexity | Days | What the number depends on |
|---|---|---|---:|---|
| 0 | **Decision gate**: does instant-only fit their users? | — | 0 | Not our work. Blocks 3 onward. |
| 1 | **`@encedo/chat-core`** — publish `lib/` + `net/` as a package: manifest, entry points, types, README. No code changes; the core is already DOM-free. | Low | 2–3 | The `hem-sdk-js` submodule becoming a real dependency, and whatever the first external consumer finds |
| 2 | **`mount()` spike** on one screen — prove the untangling on the login card alone | Medium | 2–3 | Nothing much. This is the cheap measurement. |
| 3 | **Componentise `app.ts`** — instance state, Shadow DOM, injected storage, teardown, locale in | **High** | 8–15 | ~5800 lines, ~80 module-scope listeners, ~129 `document.*` (2026-08-30 — double the file this was priced against, so treat 8–15 as a floor). **The widest range here, deliberately** — stage 2 narrows it |
| 4 | **Packaging** — `<encedo-chat>` element, iframe mode from the same package, a demo host page | Medium | 3–4 | Bundle splitting and lazy loading |
| 5 | **Open Mercato module** — widget injection, key-directory contract, CSP/CORS on their side | Medium | 3–5 | Their framework, and how much of it lands on us |
| 6 | **Hardening + docs** — host-readable-identity threat statement, integration guide, harness scenarios for mount/unmount and two instances on one page | Medium | 3–4 | How much of (b) we decide to enforce rather than document |

**Total 21–34 days — roughly 4.5 to 7 weeks**, and the spread is almost entirely
stage 3.

### The cheap path, if the point is to show them something

If what is needed is a working demo inside their application rather than a
product, **the iframe route skips stage 3 completely**: no `app.ts` refactor, an
embed page plus a `postMessage` bridge and a host-side widget. **Four to six
days.** It also happens to be the shape that keeps the keys away from the host,
so it is not merely the cheap answer — see (A) above for what it costs in
appearance and in storage partitioning.

Sequenced honestly: **iframe demo first (about a week), component afterwards if
the demo earns it.** Stage 1 is worth doing either way.

### Sequence as of 2026-10-06

The table above stays as the full-component estimate (stage 3 is now a floor
of 15 days rather than 8). The order of work changed:

| # | Step | Days | Note |
|---|---|---:|---|
| 1 | **0.7.0** and the group test | — | first, unchanged; nothing here starts before it |
| 2 | **Compatibility rule**: protocol version on the wire, a visible "older version" message | 2–3 | prerequisite for anything external; also touches PROTOCOL.md (user's GO, cryptographer note) |
| 3 | **`@encedo/chat-core`** (stage 1 above) | 2–3 | |
| 4 | **Embed page + Open Mercato PR, iframe mode** — module, postMessage bridge, key column, pinning + key-change warning, CSP | 5–7 | answers (a) with their maintainers in the PR discussion |
| 5 | **Component** (stages 2–4 above) | 18–30 | only if the iframe module earns it; `mount()` spike first |

## Next step

Nothing is coded yet (2026-10-06, the user's call). After 0.7.0: write the
compatibility rule as a PROTOCOL.md proposal for the user's GO, then the
Open Mercato proposal text that opens the PR discussion — leading with the
instant-only question (a), because it decides whether the rest is worth it.
