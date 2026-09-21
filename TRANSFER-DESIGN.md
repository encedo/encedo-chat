# Transfer — design record

**Status: BUILT AND SHIPPED since v0.5.74** (`impl/lib/xfer.ts`,
`impl/lib/xfer-session.ts`). Written as a proposal on 2026-09-13 and implemented
the same day; this header went on saying "nothing built" until 2026-09-21.

**Normative text is `docs/PROTOCOL.md` §13.1** — frames, subtypes, the
reliability model it inherits from the channel, and the consent and timeout
rules. This file keeps the reasoning and the measurements behind them.

⚠️ **Numbers here are from the day of writing and some have moved since.** The
shipped ceiling is `MAX_DIRECT` = 512 MiB, measured at 500 MB / ~41 MB/s over a
LAN on 2026-09-21; a caption travels in the offer frame (`MAX_OFFER_BODY` =
4 KiB). Where this file and the code disagree, the code and §13.1 are right.

**What it is:** sending a file **straight to the other browser over the WebRTC
DataChannel**, as part of the conversation, with no store in the middle — no
upload, no CID, no five-minute lease, nothing an operator can fetch. Offered
**only when the direct channel is already live**; otherwise the app behaves
exactly as it does today.

---

## 1. Why WebRTC only — the measurement that decided it

Two libp2p peers in one room (real EH-2 + ratchet), paced sending, counting
**delivered** payload. Against the live relay `bs3`:

| chunk | rate | delivered | throughput |
|---|---|---|---|
| 60 000 B | 32/s | 100% | 1.04 MB/s |
| 60 000 B | 48/s (5 s) | 100% | 1.56 MB/s |
| 60 000 B | 48/s (12 s) | **71%** | 1.49 MB/s |
| 60 000 B | 64/s | 76% | 1.18 MB/s |
| 60 000 B | 96/s | 19% | 0.57 MB/s |

**About 1 MB/s per room with everything delivered**, the knee between 48 and
64 messages a second. A short run hides it: 100% over five seconds at 48/s, 71%
over twelve, because buffers fill first and fail later.

Two controls, without which that number would mean nothing:

- **This machine's uplink to bs3: 6.73 MB/s** — not the limit.
- **The same test against a relay on loopback: 100% delivered up to 256/s =
  7.26 MB/s**, no knee in sight. The stack — libp2p, GossipSub, the ratchet, the
  room's per-message acks — is nowhere near being the bottleneck.

So the ceiling is **the path to the relay** (a small VM, nginx terminating TLS,
the network), not the protocol. Which settles the design question:

- through the relay a 20 MB file takes ~27 s and an 80 MB one ~107 s, and the
  bandwidth bill moves onto bs1–bs3, which today never see a file at all;
- through a DataChannel it touches neither, and the 64 KB GossipSub frame cap
  does not apply either.

Doing this over the relay would be building a slower version of the store we
already have, and paying for it in relay bandwidth. Doing it direct removes an
entire class of exposure. **So: direct only, and no fallback** — if there is no
channel, the existing path is right there and unchanged.

### What the store path still gets right

Not a rejected alternative, a division of labour. The store handles what a
direct channel cannot: groups (no acks, N recipients), a recipient whose browser
cannot do WebRTC, and the packaged desktop, where **WebKitGTK has no
`RTCPeerConnection` at all**. Transfer is an addition for the case where the two
browsers already talk directly, not a replacement for anything.

---

## 2. What the channel gives us for free

`net/webrtc.ts` creates `pc.createDataChannel('onchato')` with default options,
which means **reliable and ordered**. Everything a transfer protocol usually
spends its complexity on — retransmission, windows, gap tracking — is already
done by SCTP underneath. What remains is genuinely small:

- **Backpressure**, via `bufferedAmount` and `bufferedAmountLowThreshold`. A
  browser will happily let a script queue an entire file into memory; the send
  loop must wait rather than push.
- **Progress**, which is a UI concern, not a delivery one.
- **Cancel**, from either side, at any point.

**Acks stop being a delivery mechanism and become receipts.** The 1% cadence
still makes sense — computed identically on both sides as
`max(1, ceil(chunks/100))`, so ~100 receipts per transfer whatever the size,
nothing to negotiate — but their job is to move the sender's progress bar and to
prove the receiver is still there. Losing one costs a stale percentage, not data.

**Frame types** fit the existing scheme: control frames on the channel start
with `0x00` (`CTRL` in `net/webrtc.ts`) and content frames with `0x10` or above,
so the transfer's own frames take unused control subtypes and cannot collide
with a message.

**Chunk size 64 KB.** Not a protocol limit — the GossipSub cap does not apply
here — but the largest size every browser handles without splitting, and it
keeps the receipt cadence honest: 80 MB is 1 280 chunks, so a receipt every 13.

---

## 3. Where it lives in the UI

**One entry point, and only when it is real.** The composer's 📎 (`#btn-attach`)
keeps doing exactly what it does today. When the room's transport badge is
🟢 Direct (`conn=connected`, `noteTransport` in `app.ts`), pressing it opens a
two-item menu instead of the file picker:

```
┌─────────────────────────────────────────────┐
│  Wyślij plik                                │
│  przez czat — do 128 MB, znika po 5 minutach│
├─────────────────────────────────────────────┤
│  Transfer bezpośredni            🟢 Direct  │
│  prosto do drugiej przeglądarki,            │
│  nic nie trafia na serwer                   │
└─────────────────────────────────────────────┘
```

No badge, no channel, no menu: 📎 opens the picker as it always did. **A feature
that appears and disappears with the transport must never look like something
that broke** — hence a menu that grows an option rather than an icon that comes
and goes, and hence the badge repeated inside the menu row, so the reason is on
screen next to the choice.

### Window 1 — sending

Opens after the file is chosen, before anything moves.

```
┌───────────────── Transfer bezpośredni ──────────────────┐
│                                                          │
│   raport-q3.pdf                              8,4 MB      │
│   do: Anna                                   🟢 Direct   │
│                                                          │
│   Plik pójdzie prosto do przeglądarki Anny.              │
│   Nie trafi na żaden serwer i nie da się go              │
│   pobrać później — musicie oboje być w rozmowie.         │
│                                                          │
│   ○ Czekam, aż Anna potwierdzi odbiór…                   │
│                                                          │
│                              [ Anuluj ]                  │
└──────────────────────────────────────────────────────────┘
```

After acceptance the same window becomes the progress view — the same surface,
not a new one, so nothing jumps:

```
│   ████████████████░░░░░░░░░░░   62%   5,2 / 8,4 MB      │
│   3,1 MB/s · zostało ~1 s                                │
│                              [ Przerwij ]                │
```

### Window 2 — the receiver is asked first

The point of the confirmation is not politeness, it is that **the transfer is
synchronous**: bytes start moving the moment it is accepted, and nobody wants
8 MB arriving unannounced.

```
┌──────────────────── Przychodzi plik ─────────────────────┐
│                                                          │
│   Anna chce wysłać:                                      │
│                                                          │
│   raport-q3.pdf                              8,4 MB      │
│   PDF                                                    │
│                                                          │
│   Transfer bezpośredni — plik idzie prosto z jej         │
│   przeglądarki do Twojej, nie przez nasz serwer.         │
│   Zajmie około 3 sekund. Musicie oboje zostać            │
│   w rozmowie do końca.                                   │
│                                                          │
│              [ Nie teraz ]      [ Odbierz ]              │
└──────────────────────────────────────────────────────────┘
```

What this window must **not** do: promise anything about the contents. The name
and the size come from the sender and are shown as claims, not facts — the same
rule mentions and quotes already follow. A `.pdf` in the name does not make it a
PDF, and the window says the type as reported, nothing more.

### Window 3 — receiving, and what happens at the end

```
┌───────────────── Transfer bezpośredni ──────────────────┐
│   raport-q3.pdf   od: Anna                   🟢 Direct   │
│                                                          │
│   ████████████████████████░░░   78%   6,6 / 8,4 MB      │
│   3,1 MB/s · zostało ~1 s                                │
│                                                          │
│                              [ Przerwij ]                │
└──────────────────────────────────────────────────────────┘
```

and on completion the file is **not** written anywhere by itself:

```
│   ✓ Odebrano — raport-q3.pdf, 8,4 MB                     │
│   Plik jest tylko w tej karcie. Zamknięcie jej           │
│   znaczy, że trzeba go wysłać jeszcze raz.               │
│                                                          │
│                    [ Zamknij ]   [ Zapisz ]              │
```

That last sentence is the honest one, and it is a consequence of the design
rather than a limitation to hide: nothing was stored, so there is nothing to
come back for.

### The transcript

Both sides get an ordinary system line in the conversation — `Transfer: raport-q3.pdf
(8,4 MB) — odebrany` / `przerwany` / `odrzucony`. Not a file bubble: a file
bubble offers **Pokaż** and **Pobierz**, and after a direct transfer there is
nothing behind those buttons. A bubble that lies is worse than a line that does
not offer.

---

## 4. What breaks it, and what happens then

**The channel dies mid-file.** It can: content is demoted to the relay after a
single unconfirmed re-send (`onStall` → `plane.demote()`, no second chance), and
a demotion is permanent for the conversation. A transfer in flight must fail
loudly and offer the ordinary path — *"kanał bezpośredni przestał działać;
wyślij przez czat?"* — never silently continue over GossipSub, which is exactly
the 1 MB/s road this design refuses.

**The tab closes.** Both sides lose everything; that is what "nothing is stored"
means. The confirmation window says so before the transfer starts, not after.

**Memory.** The receiver holds the whole file in RAM before saving, so the cap
stays where the store path has it (128 MB) until it streams to disk. The File
System Access API would remove the cap for Chromium and not for Firefox, so it
is a follow-up, not part of v1.

**Two tabs of the same identity.** §9.1 already stands both down; a transfer
inherits that and does not need its own rule.

---

## 5. Open, in order of how much they change

1. **Is v1 one file at a time?** A queue is easy to add and easy to get wrong
   (two transfers sharing one channel's backpressure). Recommend: one, refuse
   the second with the reason.
2. **Does the cap stay at 128 MB** when there is no store to protect? The
   constraint is the receiver's memory, not policy.
3. **Groups: never, or later?** Never is defensible — no acks, N channels — and
   it keeps the feature honest as a two-browser thing.
4. **Protobuf.** Irrelevant here: the DataChannel carries binary already, and
   base64 only ever existed to fit inside a JSON envelope. Worth a line only
   because the relay variant would need it — there it saves 25% of the traffic
   and a third of the messages.

---

## 6. Where this leaves the store

Transfer does **not** let us close `POST /f`: groups, non-WebRTC browsers and
the packaged desktop all still need it. What it does is take the common case —
two browsers, one conversation, one file — off the store entirely, which is the
only part of this that improves the exposure rather than moving it.
