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

The UI. `web/src/app.ts` is ~5800 lines (re-measured 2026-08-30; it was 2748
when this plan was priced — **the file doubled**, so every estimate keyed to it
is a lower bound now) that assume they *are* the page:

| what | count (2026-08-30) | why it blocks embedding |
|---|---:|---|
| `document.*` | ~129 | queries the whole document, not a subtree it owns |
| listeners bound at module scope | ~80 | **importing the module runs the app**, and requires the ids to already exist |
| direct `localStorage` | ~57 | `ec-*` keys are global to the origin: no namespace, collides with a second instance |
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
5. **Lazy loading.** The bundle is ~1.32 MiB minified (2026-08-30). In someone
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
import dialog, and treating the first key seen for a contact as pinned. A
substituted key then becomes *detectable* by anyone who checks — not
*impossible*. Anything that hides the fingerprint to make the integration
smoother throws away the only defence there is.

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

## Next step

A `mount()` spike on a single screen. Not for the code — to measure honestly
what untangling those 37 module-scope listeners costs, before anyone quotes a
date.
