# onchato STUN

A STUN server on our own nodes, so a direct (WebRTC) attempt does not have to
ask a stranger where it is coming from.

## Why this exists

ICE needs one fact before it can offer a direct candidate: the address the
outside world sees. Until 2026-09-03 the client asked
`stun:stun.l.google.com:19302` for it, which handed Google the IP and the
timing of every attempt — a third party in a product built not to need one.
This runs on bs1/bs2/bs3, hosts the client is already holding a WSS connection
to, so the operator learns an address it necessarily has and nobody else learns
anything.

The client list lives in `impl/lib/ice.ts` (three nodes; ICE asks them in
parallel and one answer is enough, so a node being down costs nothing).

## What it is

`stun.mjs`, ~200 lines, zero dependencies: a Binding Request in, a Binding
Success Response with XOR-MAPPED-ADDRESS out (RFC 5389 §15.2). Both address
families. A token bucket per source address.

**It is not coturn, deliberately.** coturn is a TURN server that can also do
STUN, and TURN relays media for whoever asks — one misread config line from
being an open relay for somebody else's traffic. There is no such line here
because there is no relaying code. The same reasoning as the hand-written MQTT
client: the subset is the point, and the parts we do not implement are the ones
that would have to be kept turned off.

Also absent on purpose: TLS/DTLS (the response says what everyone on the path
already saw — the source address of the packet), RFC 5780 behaviour discovery
(`CHANGE-REQUEST` is how a STUN server is aimed at a third party), and the
`SOFTWARE` attribute (a version string is a fingerprint, and bytes in the reply
are exactly what amplification cares about).

## Install (every relay node)

```bash
cd /opt/github/encedo-chat && git pull                 # the clone the relay runs from
sudo cp infra/stun/onchato-stun.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-stun
sudo ufw allow 3478/udp
journalctl -u onchato-stun -n 5 --no-pager            # expect ✓ STUN udp4 / udp6
```

Nothing proxies this: nginx speaks TCP, STUN is UDP, so 3478/udp is the one
port that has to be open to the world. It is the only listener on this host
that is not behind nginx.

## Check it from anywhere

```bash
node impl/net/stun-probe.ts bs1.onchato.com            # or bs2 / bs3
```

It sends a real Binding Request and prints the address that comes back, which
should be the public address of the machine you ran it from. `--bad` also fires
the datagrams that must be ignored (a TURN Allocate, a wrong magic cookie, a
truncated header) and fails if any of them is answered.

In a browser: `https://onchato.com/chat?debug=1`, open Settings → the WebRTC
self-test. Its STUN stage dials the first node in the list and reports whether
a reflexive candidate came back.

## Operating notes

- **Rate limit**: 20/s per source address, burst 40 (`limiter()` in `stun.mjs`).
  An ICE gathering asks once or twice. The limit is not about load — the source
  address of a UDP datagram is a claim, not a fact, and the bucket is what stops
  a spoofed one from turning this into a small reflector aimed at somebody else.
  The response is ~32 bytes for a ~20 byte question, so the amplification on
  offer is poor to begin with.
- **Logs**: one line every five minutes with served / ignored / rate-limited
  counts and how many source addresses are in the table. `QUIET=1` silences it.
- **It holds no state worth keeping.** Restart it whenever; a client that was
  mid-gathering re-asks.
- **Direct is opt-in since 0.5.48**, so this is consulted only by clients that
  chose it in Settings.
