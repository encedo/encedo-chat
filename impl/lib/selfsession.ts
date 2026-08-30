/**
 * selfsession.ts — one active session per identity (docs/PROTOCOL.md §9.1).
 *
 * Every client subscribes to a topic derived from its OWN identity key, and
 * announces itself there. Nobody else can derive that topic or forge an announce
 * on it, so anything valid arriving on it is another window of *me*: a second
 * tab, another browser, another machine. Exactly one of them should be live —
 * two sessions of one identity in a conversation is the state that produced the
 * flapping handshakes and the dead room (see CLAUDE.md).
 *
 * **Both duplicates step down** (product decision, 2026-07-30). The spec hands
 * the session to the newer window; we close BOTH and make the user re-enter one
 * deliberately. It is the fail-closed reading: when two windows hold the same
 * identity, nothing here can tell which of them the user actually meant — and if
 * one of them is not the user at all (a lifted token, a forgotten machine),
 * handing it the live session because it arrived second is the wrong default.
 * The cost is that an accidental second tab ends both; the notice says so, and a
 * reload is one click. A page RELOAD is not affected: that window is gone before
 * the new one starts, so it never announces.
 *
 * **Where this diverges from the spec's mechanism, and why.** §9.1 compares the
 * announce's timestamp with the local session start, which assumes the announce
 * carries the *session start*. Ours (§5.5) carries the *send* time — every
 * announce is therefore "newer" than any session start, and a literal
 * implementation would have each newcomer shut itself down on the first
 * heartbeat it heard. Adding a `since` field would fix that, but §5.5 is frozen
 * for the audit, so the decision is made from local knowledge instead: a rival
 * heard while we are settling in, or appearing after we have settled, is a
 * duplicate either way — and either way both of us stop.
 */

import { buildAnnounce, verifyAnnounce, nonceCache } from './announce.ts'

export interface SelfWatchOpts {
  /** How often we say we are here. */
  heartbeatMs?: number
  /** How long after start we still count ourselves as "the newcomer". */
  graceMs?: number
  onLog?: (msg: string, level?: 'info' | 'debug') => void
  /** A duplicate window of this identity was found: this session stops too. */
  onTakenOver: (byPeer: string) => void
}

export interface SelfWatch { stop(): void }

export function watchSelfSession(
  node: any, topic: string, macKey: CryptoKey, self: string, opts: SelfWatchOpts,
): SelfWatch {
  const log = opts.onLog ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 10_000
  const graceMs = opts.graceMs ?? 3_000

  /** Sessions heard during our own first seconds: they were here before us. */
  const preexisting = new Set<string>()
  const seenNonces = nonceCache()
  let done = false
  let settled = false

  let stepping = false
  const stepDown = async (byPeer: string, why: string) => {
    if (done || stepping) return
    stepping = true
    log(`a second window of this identity is here (${byPeer.slice(0, 12)}…, ${why})`
      + ' — closing this session; the other one closes itself the same way (§9.1)')
    // One last announce on the way out. Without it the rule only half fires: a
    // settled window hears the newcomer and goes silent immediately, so the
    // newcomer — still in its own opening window — may never hear anything and
    // carries on alone. The farewell is the proof that it was here.
    try { await node.services.pubsub.publish(topic, await buildAnnounce(self, macKey)) } catch {}
    done = true
    stop()
    opts.onTakenOver(byPeer)
  }

  const handler = async (evt: any) => {
    if (done || evt.detail.topic !== topic) return
    const from = evt.detail.from?.toString?.()
    if (from === self) return
    const res = await verifyAnnounce(evt.detail.data, macKey)
    if (!res.ok || !res.peer || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)

    if (!settled) {
      // Still settling in. Record it and let the opening window close: acting on
      // the first frame would race the rival's own announce, and we want both
      // sides to reach the same conclusion, not the faster one to win.
      if (!preexisting.has(res.peer)) log(`another window is already on the self-topic: ${res.peer.slice(0, 12)}…`)
      preexisting.add(res.peer)
      return
    }
    void stepDown(res.peer, 'it is a second window of this identity')
  }

  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)
  log(`watching the self-topic ${topic.slice(0, 12)}… as ${self.slice(0, 12)}… (§9.1)`)

  const announce = async () => {
    if (done) return
    try { await node.services.pubsub.publish(topic, await buildAnnounce(self, macKey)) } catch {}
  }
  void announce()

  const settle = setTimeout(() => {
    settled = true
    if (!preexisting.size) return
    // Someone was already here when we arrived. No tie-break: both windows go.
    void stepDown([...preexisting].sort().pop()!, 'it was already here when we arrived')
  }, graceMs)
  ;(settle as any).unref?.()

  const hb = setInterval(announce, heartbeatMs)
  ;(hb as any).unref?.()

  function stop() {
    clearTimeout(settle)
    clearInterval(hb)
    try { node.services.pubsub.removeEventListener('message', handler) } catch {}
    try { node.services.pubsub.unsubscribe(topic) } catch {}
  }

  return { stop }
}
