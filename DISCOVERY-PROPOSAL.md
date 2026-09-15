# Public invites — the return channel (proposal)

**Status:** PROPOSAL, 2026-09-15. Nothing here is built and nothing is on the
wire yet. It is protocol-meaningful, so it needs the user's GO and the external
cryptographer's read before a line of it is written. `docs/PROTOCOL.md` stays
normative for what ships; this file is the reasoning and the rejected
alternatives, in the shape of `GROUPS-DESIGN.md`.

**The two roles, and they are the whole design brief.** The **Journalist** is
the inviter: they publish one link on a web page, nothing else, and they change
it whenever they like. The **Source** is the invitee: they open the link, create
a software identity, and wait. Polish in the UI: *Dziennikarz* and *Informator*.

**One line:** the invite carries a random 32-byte secret; that secret names a
topic the Journalist listens on; the Source knocks there with its identity key
sealed to the Journalist. Nothing else in the protocol changes.

---

## 1. The gap

A pair topic comes from `ss = ECDH(IK_a, IK_b)` (§5.1). It needs **both** keys.

After the Journalist publishes an invite, the Source holds `IK_pub` of the
Journalist and can therefore derive the pair topic, the Announce MAC key, the
rotation offset — everything. The Journalist holds nothing about the Source and
can derive none of it. The contact is one-way by construction.

The machinery for the other direction already exists and is manual: `Invite`
has a `reply` flag (`lib/invite.ts`), so the Source's client can mint a reply
link carrying its own key, and the Journalist imports it and is not asked to
send its key again. What is missing is **delivery of that reply**. Today it
needs a channel the two do not have, which is the channel the whole product
exists to avoid needing.

`knock` (§7.4) does not help: it is an empty "I am here" that rides a pair topic
that already exists, and it is 1:1 only.

## 2. The proposal: an inbox topic named by the invite

Add one field to the invite: `s`, 32 random bytes, base64url. The invite becomes
`{p, n, s}` — public key, display name, inbox secret. The link grows by ~46
characters.

```
T_inbox = topicFromSecret(s, { networkId, dateUTC })
```

That is `lib/rendezvous.ts`'s existing function, the same one `groupTopicFromSecret`
wraps for §5.3. **No new cryptographic construction is introduced.**

- The **Journalist** subscribes to `T_inbox` whenever it is online.
- The **Source**, holding the link, computes the same topic and publishes one
  knock there.
- Nobody else can compute it. The topic is a 32-byte secret's image, exactly
  like a group topic.

The daily rotation uses the existing `rotationOffsetSec(s, params)` — that
function takes any secret, so each invite gets its own rollover instant and
inboxes do not all re-subscribe at 00:00 (§5.4's reason, unchanged).

### 2.1 The knock is sealed to the Journalist

The payload has the shape of an EH-2 `msg1` (§6.1) and uses only primitives
already in the build:

```
eph            <- fresh X25519 keypair, used once
k    = HKDF(ECDH(eph_priv, IK_A_pub), "encedo-chat-invite-knock-v1", s)
body = AES-256-GCM(k, { ik: IK_B_pub, name, note })
wire = { eph: eph_pub, ct: body }
```

**Confirmed by the cryptographer, 2026-09-15**: the schedule is right and the
binding to `s` is important. It is therefore load-bearing rather than
incidental — a knock sealed for one invite does not open under another even
though both are addressed to the same identity key, and `test/knock.test.ts`
fails if the `info` is dropped. Built in `lib/knock.ts`.

The Journalist opens it with `ECDH(IK_A_priv, eph_pub)`.

**The ephemeral key is not decoration.** Without it the Source's identity key
would sit in the clear on a topic that every holder of the published invite can
subscribe to, including whoever scraped it off the web page. With it, an
observer on that topic sees a random public key and a ciphertext: that *someone*
knocked, when, and how large the frame was. Not who.

### 2.2 After acceptance, nothing is new

The Journalist accepts, imports `IK_B` as an ordinary contact, and can now
derive the pair topic. The Source **has been watching that pair topic since it
clicked the link** — it could always derive it — so the Journalist's first
Announce lights the Source's contact dot and §5.5 presence, §6 EH-2 and §7 the
ratchet take over unchanged.

This is why the Source's UI is honest with no new machinery: the pending contact
is a normal contact with a normal presence watch. "Waiting" is just "not
announcing yet".

## 3. The flow

```mermaid
sequenceDiagram
    autonumber
    participant J as Dziennikarz
    participant W as Web page
    participant N as Node (GossipSub)
    participant S as Informator

    Note over J: s = 32 random bytes<br/>T_inbox = topicFromSecret(s)
    J->>N: subscribe T_inbox
    J->>W: publish the link, fragment i={p, n, s}

    S->>W: open link
    Note over S: create software identity IK_B<br/>read {p, n, s} from the URL fragment
    Note over S: T_pair = topic(ECDH(IK_B, p))<br/>T_inbox = topicFromSecret(s)
    S->>N: subscribe T_pair (presence watch, waiting)
    S->>N: publish on T_inbox<br/>{eph_pub, seal(IK_B, name, note)}
    N->>J: knock

    Note over J: open with ECDH(IK_A_priv, eph_pub)<br/>show name claimed + fingerprint + note
    alt Journalist accepts
        Note over J: import IK_B as a contact<br/>T_pair is now derivable
        J->>N: join T_pair + Announce (§5.5)
        N->>S: Announce -> the contact lights up
        S-->>J: EH-2 handshake (§6), then the ratchet (§7)
    else Journalist ignores
        Note over J: no answer is sent at all
        Note over S: stays "waiting"; re-knocks while the app is open
    end

    Note over J: retire an invite = unsubscribe T_inbox.<br/>Silent, local, and only that invite dies.
```

## 4. Decisions

### 4.1 One topic per invite, not one inbox per identity

**Yes: three published invites means three subscriptions.** That is the cost and
it buys two things a shared inbox cannot.

*Revocation that actually revokes.* Retiring an invite is unsubscribing. It needs
no announcement, tells nobody, and cannot be refused. With one shared inbox,
"revoking" an invite could only be client-side filtering — the holder of the
burned link keeps publishing onto the live topic — and a real revocation would
kill every other source's route at the same time.

*Unlinkability between sources.* With per-invite topics, an adversary holding
invite #1 learns nothing about traffic on invite #2: different secret, different
topic, no correlation. With one shared inbox, anyone who ever received any of
the Journalist's invites can sit on the single topic and count and time **every**
knock from **every** source. For this threat model that is the stronger argument
of the two.

The cost is small in context: a client already holds one topic per contact plus
the self-topic (§9.1), so a handful of live invites is a rounding error against
twenty contacts. A Journalist who wants one link per outlet gets one topic per
outlet.

*Rejected refinement:* deriving `s_i = HKDF(master, "invite", i)` so only one
master secret is stored. It saves key management, changes the subscription count
not at all, and adds a construction for no security gain. Random per invite is
simpler and independent.

### 4.2 The secret lives in the URL fragment

`inviteLink` already builds `origin + path + '#' + payload`, and a fragment is
**not sent to the server**. So a Source clicking a published link does not hand
the invite secret to onchato.com's own web host — the app reads it in the
browser. This property is free today and the proposal must not lose it.

It says nothing about the web page the Journalist published on: anyone who reads
that page holds the secret. That is the point of a public address.

### 4.3 The name is a claim; the fingerprint is the fact

The knock carries a display name and a short note, both written by a stranger.
They get the treatment every stranger's string already gets in this codebase:
plain text, never markup, length-capped, and shown **next to the fingerprint of
`IK_B`**, which is the only part a person can later compare against something
else. Same rule as `re.au` in §7.4 and the invite import screen.

### 4.4 A knock is a request, never a contact

**The user's decision, 2026-09-15.** An accepted knock adds a contact; an
unaccepted one adds nothing. There is no path on which a stranger's frame
becomes an entry in somebody's contact book without a person having looked at
it and said yes.

This is also what makes the missing transcript binding acceptable (§9.2). The
knock does not authenticate anybody and is not asked to: it carries a key that
still has to prove itself through the ordinary EH-2 handshake, and in between
sits a human being reading a fingerprint. A knock that lies costs the reader a
glance and an Ignore.

It follows that the pending list is attacker-fillable and must be built as
such: capped, rate-limited, and cheap to clear. That is §7's problem, not this
one's, but the two decisions have to be read together.

### 4.5 Impersonation is out of scope, and saying so is the honest answer

**The user's decision, 2026-09-15.** Anybody can claim any name in a knock, and
a hostile web page can publish its own invite under a Journalist's name. The
protocol does not try to harden either, because it cannot: there is nothing it
could check a stranger's claim against. What it does instead is refuse to
pretend — the name is rendered as the claim it is, the fingerprint is shown
next to it, and verifying that fingerprint is an operational act on another
channel.

This is the same position §4.3 takes about names and §6 takes about a published
link. It is written down as a decision rather than left implied, because the
tempting thing to build here is a "verified" badge that means nothing.

### 4.6 The decoy schedule is deterministic, seeded by what the watcher lacks

**From the user's suggestion, 2026-09-15, with one correction that matters.**

Deterministic is right, and for a reason beyond tidiness. If each device rolled
its own random schedule, a Journalist running two clients would emit two
independent decoy streams, so the topic's traffic rate would depend on how many
devices are listening — which is itself a fact about the Journalist, leaking
through the very mechanism meant to leak nothing. A schedule computed from a
seed gives one stream no matter how many clients compute it, and it survives a
restart without stored state.

**The correction: the seed cannot be the invite secret.** That secret is
printed on a web page. Derive the schedule from it and every holder of the link
can compute exactly when the decoys fall, subtract them, and read off the real
knocks — which is not a weakened mitigation but an inverted one, leaving the
observer better off than with no decoys at all.

So the seed comes from something only the Journalist can compute, bound to the
invite so the schedules of two invites stay independent (§4.1):

```
seed_i = HKDF(ECDH(IK_J, IK_J_pub), "encedo-chat-invite-decoy-v1", s_i)
```

The ECDH of an identity against its own public key is the §9.1 self-topic
trick, and it has the property wanted here: only the holder of that identity
can compute it, on any device, without storing anything.

Telling a decoy from a real knock is already solved inside the seal — the
plaintext's first byte is the kind (`lib/knock.ts`) — so only the recipient can
do it, which is the correct audience for that fact.

### 4.7 The Journalist must be online. This is not a bug to route around

GossipSub stores nothing (§1) and this proposal does not change that. A knock
reaches a subscriber that is present, or it reaches nobody.

Three honest responses, in order of preference:

1. **The Source's client re-knocks** while the pending contact exists and the app
   is open, and the UI says plainly that it has not been delivered yet. For a
   source, ambiguity here is the dangerous failure: "I clicked and something
   probably happened" must never be the state on screen.
2. **The Journalist runs the always-on instance** their own scenario implies. A
   person who publishes a public contact address is already committing to being
   reachable; the CLI on a VPS is the cheap form of that.
3. **A mailbox on the node** — explicitly *not* proposed. It would mean the node
   stores something for somebody, which contradicts "transport only" and would
   need `THREAT-MODELS.md` reopened. If it is ever wanted it must arrive as a
   deliberate, opt-in, size- and time-bounded store of opaque bytes, not as a
   quiet convenience.

## 5. What this must not become

**Not a directory.** There is no lookup, no registry, and no way to reach
somebody who did not hand you a link. §1's "no prekey server, no directory
service" survives intact, and this is the property easiest to erode by accident
— the moment a knock can be addressed by identity key alone rather than by an
invite secret, it is gone.

## 6. Exposure, stated plainly

What the **node** learns: that a topic exists and carries small frames, with
timing and size. The same as any other topic it carries.

What a **holder of the published invite** learns, if they subscribe to that one
inbox topic: that knocks happen, when, and how big. Not who, because of §2.1.
This is the price of a public address and it is bounded to one invite.

What the **Journalist** learns about the Source: its identity key, its claimed
name and note. Nothing about its address, because content defaults to the relay
since 2026-09-03 and the direct WebRTC plane is opt-in. **For this scenario the
direct plane should stay off by default and the UI should say why** — a source
should not hand its IP to a journalist as a side effect of saying hello.

What the **Source** must still verify out of band: that the published link is
the Journalist's. A hostile web page can publish its own invite under a
journalist's name, and no protocol fixes that. The fingerprint is what a
second channel would be used to compare.

### 6.1 The inbox topic is public, and that is the real cost

Every other topic in this protocol is unguessable: it is the image of a secret
that never leaves the two people who derive it. **The inbox topic is not.** Its
secret is printed on a web page, so the topic is public knowledge to anyone who
reads that page, and being publicly reachable is the entire point. The
consequences should be stated rather than discovered.

**Anyone holding the link can subscribe, and therefore can watch.** They learn
that a knock happened, at what second, how many there were, and how large the
frame was. This is the property the rest of the protocol does not give away,
and here it is given away deliberately.

**They do not learn who.** §2.1 holds: the only cleartext is a one-shot
ephemeral public key, so an observer sees that *someone* knocked. The exposure
is traffic analysis, not deanonymization — and for a Journalist and a Source
traffic analysis can be enough on its own. "Somebody contacted this journalist
at 14:32" is a small fact that becomes a large one next to network-level
observation of a handful of suspects. Treat it as the headline risk of the
whole feature.

**The daily rotation buys nothing here, and §5.4 must not be read as if it
did.** A pair topic rotates out of an adversary's reach because the adversary
never had the pair secret. An inbox secret is public, so tomorrow's topic is
computed by the watcher exactly as it is by the Source. Rotation still spreads
load; it provides no unlinkability on this topic.

**They also cannot tell whether the Journalist is listening.** The relay
subscribes to any topic a client uses (`relay.mjs`, the `[+topic]` path), and
browser clients are connected only to the relay, so the subscriber set a
watcher can see contains the relay and nothing else. Being offline and being
uninterested look the same from outside.

**The mitigation that works is indistinguishable decoy traffic.** The
Journalist's own client publishes well-formed decoy knocks on its own inbox, on
a randomised schedule, padded to the same constant size as a real one. Then
"a knock happened" carries no information, because it happens anyway. Two
conditions make or break it:

- **Padding is mandatory, decoys or not.** A knock must be a fixed size, or the
  note's length distinguishes people, and a decoy is distinguishable from a
  real knock on size alone, which defeats the whole exercise.
- **The decoy must be a real ciphertext under a real ephemeral key.** Random
  bytes are distinguishable from an AEAD frame by anyone who tries to open it
  and by anyone who checks its structure.

This also fixes a correctness problem the proposal otherwise has, and the two
wants the same mechanism. **The relay evicts a topic that has been idle for
120 s** (`[-topic] evicted ... (idle > 120s)`; 209 of them in one day on bs1).
An inbox where the Journalist only listens and nobody knocks is exactly that:
idle. A decoy on a schedule shorter than the eviction window is the keepalive,
and it is cheap — a knock every 60 s is a quarter of what one presence watch
already costs in Announce traffic.

**What stays outside the protocol.** The Source's address reaches the relay on
publish, like every other publish. A Source who needs that hidden needs Tor or
a VPN, and the UI should say so at the moment of knocking rather than in
documentation nobody reads. This is the same advice SecureDrop gives, for the
same reason.

**Rejected: rotating the invite as a defence.** An adversary who re-reads the
page gets the new link with the next visitor. Rotation defends against somebody
who scraped once and stopped looking, which is not the adversary this feature
has.

**Rejected: a per-visitor secret minted by the web page.** It would give every
Source its own topic and remove correlation between them entirely — at the cost
of the web server knowing, and logging, every visitor who took a link. For a
Journalist that record is worse than the leak it removes: it is a list of
candidate sources, held by the machine most exposed to a subpoena. §4.2's
fragment property exists precisely so the web host learns nothing.

**The honest comparison.** This is the trade a public email address or a
published SecureDrop landing page already makes, and neither hides that
somebody made contact. What this design keeps that a mailto: does not is the
content of the knock and the identity behind it.

## 7. Abuse

A public address attracts what public addresses attract.

- Rate-limit knocks per topic in the client, and cap the pending list.
- Rotating the invite is the blunt, effective answer, and §4.1 is what makes it
  cheap.
- A proof-of-work stamp in the knock would price bulk knocking. It is an
  option, not a v1: it costs the honest source a second of CPU and buys little
  against an adversary who cares.

## 8. Cost, if it is approved

New: one field in `Invite`, one derivation call, one envelope type, one pending-
requests screen, and one persisted "invites I published" list on the Journalist's
side. `topicFromSecret`, `rotationOffsetSec`, the AEAD and the ephemeral DH all
exist and are covered by tests today.

## 9. For the cryptographer

1. ~~Is `HKDF(ECDH(eph, IK_A), "encedo-chat-invite-knock-v1", s)` the right
   schedule, with the invite secret as HKDF `info`?~~ **ANSWERED 2026-09-15:
   yes, and the binding matters.** Implemented as written.
2. ~~Is the one-shot sealed knock acceptable without any transcript binding?~~
   **SETTLED 2026-09-15 by the product decision in §4.4**: a knock is a request
   a person accepts, never an automatic contact, so the frame is not asked to
   authenticate anybody. Still worth a sanity read, but it is no longer a
   blocking question.
3. Does the unlinkability claim in §4.1 hold as stated against an adversary
   holding several of one Journalist's invites? **Requirement stated by the
   user, 2026-09-15: the invites must be independent and uncorrelated.** The
   topics are, by construction — independent random secrets, so holding one
   invite computes nothing about another. The correlation that remains is in
   the TIMING, and §4.6 is what closes it: a decoy schedule shared across a
   Journalist's invites would let an adversary holding two of them line the
   streams up and recognise both as one person's. Per-invite seeds are
   therefore not a refinement but part of the claim. The question left for the
   cryptographer is whether per-invite seeding is sufficient, or whether the
   arrival pattern of REAL knocks still links two invites over time.
4. ~~Is there any reason to prefer signing the knock over sealing it?~~
   **DECIDED 2026-09-15: sealing only.** Sealing means only the recipient can
   read the frame and nobody can prove who wrote it; signing would attach proof
   of authorship that anyone holding the public key could verify, including
   whoever later seizes the Journalist's device, who could then demonstrate
   that a particular person knocked. No argument was found for the other way.
5. §6.1 and §4.6: the schedule is now deterministic, per invite, and seeded
   from something only the Journalist can compute. Given that, does it buy what
   it claims against an adversary who watches for months, or does the
   real-knock distribution still show through over time? Concretely: is a
   constant rate better here than a pseudo-random one, given that the event
   being hidden is RARE and the cover is continuous — and what rate, against a
   relay that evicts a topic idle for 120 s?
