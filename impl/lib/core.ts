/**
 * core.ts — headless core facade. ONE API that both front-ends (web GUI + CLI)
 * consume, so the UIs stay pure UI. Consolidates what used to be duplicated in
 * app.ts / chat-session.ts / bob / alice / ec:
 *   - Identity (HEM or software), the ECDH holder,
 *   - deriveRoom: ss = ECDH(IK_a, IK_b) → topic + interim keys,
 *   - Conversation: transport (peer + relay dial) + join + the typing/away/leave
 *     state machine, behind sendText / noteActivity / leave.
 *
 * The message crypto (Session), rendezvous, and transport layers are unchanged;
 * this is orchestration on top of them. EH-2 / the §13 data plane will slot in
 * here (openConversation) without touching a single UI.
 */

import { topicFromSecret, announceMacKey, todayUTC, type RvParams } from './rendezvous.ts'
import { interimSession } from './session.ts'
import { joinChat, type RoomKeys, type ChatOpts, type Eh2Options } from './room.ts'
import { dhFromEcdh } from './x25519.ts'
import { createPeer, dial } from '../net/peer.ts'
import { createMqttPeer } from '../net/mqtt-node.ts'
import { attachWebRTC, type WebRTCPlane } from '../net/webrtc-plane.ts'
import { watchSelfSession, type SelfWatch } from './selfsession.ts'
import { b64, unb64 } from './wc.ts'

export interface Identity {
  handle: string
  pub: string // base64
  ecdh(peerPubB64: string, peerKid?: string): Promise<Uint8Array> // raw 32-byte shared secret; peerKid → in-HSM two-KID ECDH
}
export type RoomParams = RvParams
/** A chat peer: raw pubkey, plus an in-HSM `kid` when it's a HEM (imported) contact. */
export interface Peer { pub: string; kid?: string }

/** Build an Identity from an already-authenticated HEM session (browser-safe — no fs). */
export function hemIdentityFrom(hem: any, kid: string, handle: string, pub: string): Identity {
  return {
    handle,
    pub,
    async ecdh(peerPubB64: string, peerKid?: string) {
      const t = await hem.authorizePassword(null, `keymgmt:use:${kid}`) // cached derived key → no re-prompt
      // HEM contact (imported → has a kid): two-KID ECDH, both operands in-device.
      // Local / one-off contact (no kid): raw peer pubkey.
      return peerKid ? hem.ecdhKid(t, kid, peerKid) : hem.ecdh(t, kid, peerPubB64)
    },
  }
}

/**
 * Software identity in the browser (dev / no-HEM): a WebCrypto X25519 keypair
 * persisted via injected load/save (per-tab sessionStorage for testing). Same
 * Identity contract; ECDH via crypto.subtle X25519. Not HSM-anchored — for
 * testing and users without a HEM. Interoperates with HEM identities (X25519).
 */
export async function browserSoftwareIdentity(handleHint: string, load: () => string | null, save: (v: string) => void): Promise<Identity> {
  const subtle = globalThis.crypto.subtle
  let handle: string, pub: string, privJwk: JsonWebKey
  const saved = load()
  if (saved) {
    const d = JSON.parse(saved); handle = d.handle; pub = d.pub; privJwk = d.priv
  } else {
    const kp = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
    pub = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)))
    privJwk = await subtle.exportKey('jwk', kp.privateKey)
    handle = handleHint
    save(JSON.stringify({ handle, pub, priv: privJwk }))
  }
  const priv = await subtle.importKey('jwk', privJwk, { name: 'X25519' }, false, ['deriveBits'])
  return {
    handle,
    pub,
    async ecdh(peerPubB64: string) {
      const peerPub = await subtle.importKey('raw', unb64(peerPubB64), { name: 'X25519' }, false, [])
      return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peerPub }, priv, 256))
    },
  }
}

// ---- contact book (peer pubkeys) ----------------------------------------
export interface Contact { name: string; pub: string; kid?: string; source: 'hem' | 'local' }
export interface ContactBook {
  list(): Promise<Contact[]>
  add(name: string, pubB64: string): Promise<void>
  remove(c: Contact): Promise<void>
}

const td = new TextDecoder()
const peerNameFromDescr = (d: Uint8Array | null) => (d ? td.decode(d).split('\0')[0].split(',')[1] : undefined) ?? '(?)'

/**
 * HEM-backed contact book: peers live in the HSM as CURVE25519 public keys with
 * DESCR `ETSEIC:peer,<name>,ik` — HSM-anchored + portable (same HEM elsewhere =
 * same contacts). The pubkey isn't returned by search, so it's fetched per kid.
 */
export function hemContactBook(hem: any): ContactBook {
  return {
    async list() {
      const listTok = await hem.authorizePassword(null, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, 'ETSEIC:peer,')
      const out: Contact[] = []
      // one getPubKey per contact — current FW's api/search doesn't return pubkeys.
      // TODO(newer FW): api/search returns the public keys directly → drop this loop
      // and read `pub` straight off the search entry (one call for the whole list).
      for (const k of keys) {
        const useTok = await hem.authorizePassword(null, `keymgmt:use:${k.kid}`)
        const { pubkey } = await hem.getPubKey(useTok, k.kid)
        out.push({ name: peerNameFromDescr(k.description), pub: pubkey, kid: k.kid, source: 'hem' })
      }
      return out
    },
    async add(name: string, pubB64: string) {
      const impTok = await hem.authorizePassword(null, 'keymgmt:imp')
      const descrB64 = b64(new TextEncoder().encode(`ETSEIC:peer,${name},ik`))
      await hem.importPublicKey(impTok, `chat-peer-${name}`, 'CURVE25519', unb64(pubB64), descrB64)
    },
    async remove(c: Contact) {
      if (!c.kid) return
      const delTok = await hem.authorizePassword(null, 'keymgmt:del')
      await hem.deleteKey(delTok, c.kid)
    },
  }
}

/**
 * Local contact book (browser-only / one-off): peers kept in injected
 * load/save storage (e.g. localStorage). Nothing leaves the device, nothing is
 * written to the HEM. ECDH still works — it only needs the raw peer pubkey.
 */
export function localContactBook(load: () => Array<{ name: string; pub: string }>, save: (list: Array<{ name: string; pub: string }>) => void): ContactBook {
  return {
    async list() { return load().map((c) => ({ name: c.name, pub: c.pub, source: 'local' as const })) },
    async add(name: string, pubB64: string) {
      const l = load().filter((c) => c.name !== name)
      l.push({ name, pub: pubB64 })
      save(l)
    },
    async remove(c: Contact) { save(load().filter((x) => x.name !== c.name)) },
  }
}

export interface ContactManager {
  list(): Promise<Contact[]>
  add(name: string, pubB64: string, persistent: boolean): Promise<void>
  remove(c: Contact): Promise<void>
}

/**
 * Merge a permanent (HEM) and a local book into one: `list()` concatenates both,
 * `add(…, persistent)` routes (HEM vs local), `remove(c)` routes by `c.source`.
 */
export function mergedContactBook(hem: ContactBook, local: ContactBook): ContactManager {
  return {
    async list() { return [...(await hem.list()), ...(await local.list())] },
    add(name: string, pubB64: string, persistent: boolean) { return (persistent ? hem : local).add(name, pubB64) },
    remove(c: Contact) { return (c.source === 'hem' ? hem : local).remove(c) },
  }
}

/** A ContactManager with only a local backend (software identities have no HEM). */
export function localOnlyManager(local: ContactBook): ContactManager {
  return {
    list: () => local.list(),
    add: (name: string, pubB64: string, _persistent: boolean) => local.add(name, pubB64),
    remove: (c: Contact) => local.remove(c),
  }
}

/**
 * Derive the day's room for a pair: the topic (§5) plus the content keys.
 *
 * Rendezvous is unchanged either way — topic and Announce MAC key come from
 * `ss = ECDH(IK_a, IK_b)`. What changes is how content is sealed: `eh2` swaps
 * the interim static key for a per-peer EH-2 handshake + ratchet negotiated
 * inside the room (§6–7). The pair secret is then used ONLY for rendezvous.
 */
export async function deriveRoom(
  id: Identity,
  peer: Peer,
  p: RoomParams,
  eh2?: { onState?: Eh2Options['onState']; ratchet?: Eh2Options['ratchet'] } | false,
): Promise<{ topic: string; keys: RoomKeys }> {
  const ss = await id.ecdh(peer.pub, peer.kid)
  const topic = await topicFromSecret(ss, p)
  const macKey = await announceMacKey(ss, p)
  if (eh2) {
    // The EH-2 DHs run against the peer's EPHEMERAL keys, so no contact `kid`
    // here — just our IK against raw public keys (HEM raw ecdh, §4.3).
    const ik = dhFromEcdh(id.pub, (peerPubB64) => id.ecdh(peerPubB64))
    return { topic, keys: { macKey, eh2: { ik, peerIkPub: unb64(peer.pub), ...eh2 } } }
  }
  return { topic, keys: { macKey, session: await interimSession(ss, p) } }
}

/**
 * The self-topic (§5.2): the same derivation as a pair topic, with ourselves as
 * the peer. `ss = ECDH(IK, IK_pub)` is computable only by the holder of that IK,
 * so the topic and its Announce key are ours alone — which is what makes
 * anything valid on it another window of *us* (§9.1).
 */
export async function deriveSelfRoom(id: Identity, p: RoomParams): Promise<{ topic: string; macKey: CryptoKey }> {
  const ss = await id.ecdh(id.pub)
  return { topic: await topicFromSecret(ss, p), macKey: await announceMacKey(ss, p) }
}

const TYPING_STOP_MS = 4_000 // stop "typing" after this idle gap
const AWAY_MS = 60_000 // go "away" after this much no activity
const FLUSH_MS = 250 // let the leave reach the relay before teardown

export interface OpenOpts extends ChatOpts {
  relay: string
  /** See `SessionOpts` — the fall-back transport, chosen per session. */
  transport?: 'libp2p' | 'mqtt'
  broker?: string
  params?: RoomParams
  webrtc?: boolean // enable the WebRTC direct data plane (browser only)
  onWebrtcState?: (s: string) => void // WebRTC conn/ICE state (for a UI badge)
  /** Seal content with EH-2 + Double Ratchet (§6–7) instead of the interim key. */
  eh2?: boolean
  /** EH-2 handshake progress per peer (for a UI badge). */
  onSecurity?: Eh2Options['onState']
  /** Narration for a UI console (the engine never writes to one itself). */
  onLog?: ChatOpts['onLog']
  /** Delivery confirmations for the message status in the UI. */
  onDelivered?: ChatOpts['onDelivered']
  onUndelivered?: ChatOpts['onUndelivered']
  onLateDelivered?: ChatOpts['onLateDelivered']
  /**
   * Our own transport, as opposed to the peer's presence. `offline` means this
   * client currently has no way to reach the relay at all — a distinction the UI
   * had no way to draw, so a frozen laptop and a peer who left looked identical.
   */
  onLink?: (state: LinkState) => void
  /** Someone in the room is not this contact — usually a second tab on the same identity. */
  onForeign?: ChatOpts['onForeign']
  /**
   * Another window of THIS identity took the session over (§9.1). The transport
   * is already down and the ratchets are gone by the time this fires; the UI
   * should clear what it is showing and say where the session went (§9.2).
   * Omit it and the self-topic watch is not started at all.
   */
  onSessionTakenOver?: (byPeer: string) => void
}
export type LinkState = 'online' | 'reconnecting' | 'offline'
export interface Conversation {
  peerId: string
  topic: string
  sendText(body: string): string // returns the sent message id (for reactions)
  /** Send a message marked undelivered again, keeping its id. False = nothing to resend. */
  resend(id: string): boolean
  sendReaction(toId: string, emoji: string): void
  noteActivity(): void // UI calls on user input → drives "typing" + resets "away"
  noteAway(): void // UI calls on blur/tab-hidden → "away" now
  refresh(): void | Promise<void> // UI calls when the tab becomes visible again (throttled/frozen)
  who(): string[]
  secured(): string[] // peers with a live EH-2 ratchet (empty in interim mode)
  leave(): Promise<void> // presence:leave last-will + clean transport stop
}

/**
 * A client session: ONE transport, many rooms.
 *
 * Everything that is per-CLIENT rather than per-conversation lives here — the
 * libp2p node, the relay connection and its health, and the §9.1 self-topic
 * watch. Rooms are opened on top of it.
 *
 * That split is not tidiness. The previous shape built a whole node and a whole
 * relay connection *inside* `openConversation`, which was invisible while the UI
 * only ever held one chat: twenty contacts open at once would have meant twenty
 * nodes and twenty WebSockets to the same relay, for twenty topics that one
 * connection carries happily. It also duplicated the takeover watch per room,
 * when "one active session per identity" is by definition a per-identity thing.
 */
export interface ClientSession {
  /** Our ephemeral PeerId for this session. */
  readonly self: string
  /** Open a room with one contact on this session's transport. */
  open(peer: Peer, opts: RoomOpts): Promise<Conversation>
  /** The tab came back: re-dial if needed, then wake every open room. */
  refresh(): Promise<void>
  /**
   * The platform says the network went away or came back (the browser's
   * `offline`/`online` events). Worth wiring: it is immediate and certain,
   * where everything else here has to infer it from silence — and a socket
   * that survives a Wi-Fi drop as a zombie infers it very slowly. Coming back
   * forces a hang-up and a fresh dial, because that zombie is still there.
   */
  setOffline(offline: boolean): void
  /** Stop every room and the transport. */
  close(): Promise<void>
}

export interface SessionOpts {
  /** libp2p relay multiaddr — ignored when `transport` is `'mqtt'`. */
  relay: string
  /**
   * Which transport carries rendezvous, presence and signalling.
   *
   * `libp2p` (default) is the main one. `mqtt` is the **fall-back**: same
   * engine, same crypto, a broker instead of a GossipSub mesh — see the MQTT
   * section in README.md for what that costs and what it buys.
   */
  transport?: 'libp2p' | 'mqtt'
  /** Broker URL for `transport: 'mqtt'` (`wss://host/mqtt`, or `mqtt://host:1883` in Node). */
  broker?: string
  params?: RoomParams
  onLog?: ChatOpts['onLog']
  /** Our own transport state — see `LinkState`. */
  onLink?: (state: LinkState) => void
  /**
   * Another window of THIS identity appeared, so both stand down (§9.1). By the
   * time this fires the transport is gone and every room is stopped; the UI
   * should clear what it shows. Omit it and the self-topic watch is not started.
   */
  onSessionTakenOver?: (byPeer: string) => void
}

/** Per-room options: everything in OpenOpts that is not about the transport. */
export type RoomOpts = Omit<OpenOpts, 'relay' | 'params' | 'onLink' | 'onSessionTakenOver'>

const REDIAL_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]

export async function startSession(id: Identity, opts: SessionOpts): Promise<ClientSession> {
  const log = opts.onLog ?? (() => {})
  const params = opts.params ?? { networkId: 'main', dateUTC: todayUTC() }
  const viaMqtt = opts.transport === 'mqtt'
  if (viaMqtt && !opts.broker) throw new Error('transport "mqtt" needs a broker url')
  const dialT0 = Date.now()
  const node: any = viaMqtt
    ? await createMqttPeer({ url: opts.broker!, onLog: opts.onLog })
    : await createPeer()
  /** Dial, or re-dial. The two transports differ here and nowhere else. */
  const redial = () => (viaMqtt ? node.reconnect() : dial(node, opts.relay))
  if (!viaMqtt) await redial()
  const self = node.peerId.toString()
  log(`session up over ${viaMqtt ? 'MQTT' : 'libp2p'} in ${Date.now() - dialT0} ms as ${self.slice(0, 12)}…`)

  /** Every room open on this transport — refreshed, flushed and stopped together. */
  interface OpenRoom { refresh(): void; flushPending(): void; stop(): void; sendPresence(s: any): void }
  const rooms = new Set<OpenRoom>()

  // ---- the transport, watched out loud -------------------------------------
  // Losing the relay connection used to be invisible: rooms kept their state,
  // badges stayed green, presence took 90 s to expire, and messages went into a
  // socket that no longer existed. The only thing that noticed was the user,
  // once nothing had arrived for a while. So watch it, say so, and get back on
  // by ourselves instead of waiting for a tab to be focused.
  let link: LinkState = 'online'
  let redialing = false
  let closed = false
  const setLink = (s: LinkState) => {
    if (s === link) return
    link = s
    log(`link: ${s}`)
    opts.onLink?.(s)
  }
  const connected = () => {
    try { return node.getConnections().length > 0 } catch { return false }
  }
  /**
   * `force` is for the case where the transport SAYS it is connected and is not:
   * the connection object is there, nothing has written to it since the network
   * went away, and waiting for `connected()` to turn false would mean waiting
   * for a TCP timeout. Hang up first, then dial.
   */
  const reconnect = async (force = false) => {
    if (redialing || closed) return
    redialing = true
    setLink('reconnecting')
    if (force) {
      for (const c of node.getConnections()) { try { await c.close() } catch {} }
    }
    for (let i = 0; !closed && !connected(); i++) {
      try {
        await redial()
        break
      } catch (e: any) {
        const wait = REDIAL_BACKOFF[Math.min(i, REDIAL_BACKOFF.length - 1)]
        log(`re-dial failed (${e?.message ?? e}) — again in ${wait} ms`)
        // Past the first few tries this is a machine with no network at all;
        // saying "offline" is more honest than an endless "reconnecting".
        if (i >= 2) setLink('offline')
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    redialing = false
    if (closed) return
    if (connected()) {
      setLink('online')
      log('relay connection restored — announcing and flushing what is waiting')
      for (const r of rooms) { r.refresh(); r.flushPending() } // oldest first: an outage must not reorder a backlog
    }
  }
  node.addEventListener?.('connection:close', () => {
    if (!closed && !connected()) { log('lost the relay connection'); void reconnect() }
  })
  // Belt and braces: events can be missed (a frozen tab wakes with a socket that
  // is dead but never fired a close), so look for ourselves as well.
  const linkWatch = setInterval(() => {
    if (closed) return
    if (!connected()) void reconnect()
    else setLink('online')
  }, 10_000)
  ;(linkWatch as any).unref?.()

  const shutdown = async (why: string) => {
    if (closed) return
    closed = true
    log(`session closing: ${why}`)
    selfWatch?.stop()
    clearInterval(linkWatch)
    for (const r of rooms) { try { r.sendPresence('leave') } catch {} }
    await new Promise((r) => setTimeout(r, FLUSH_MS))
    for (const r of rooms) { try { r.stop() } catch {} }
    rooms.clear()
    try { await node.stop() } catch {}
  }

  // ---- §9.1: one active session per identity -------------------------------
  // Best effort by design: if the self-topic cannot be derived (a HEM that
  // refuses an ECDH against its own public key, say) the session runs on without
  // it. Losing the takeover rule is a nuisance; losing the chat is not an
  // acceptable trade for it.
  let selfWatch: SelfWatch | null = null
  if (opts.onSessionTakenOver) {
    try {
      const selfRoom = await deriveSelfRoom(id, params)
      selfWatch = watchSelfSession(node, selfRoom.topic, selfRoom.macKey, self, {
        onLog: opts.onLog,
        onTakenOver: (byPeer) => {
          void (async () => {
            await shutdown(`a second window of this identity appeared (${byPeer.slice(0, 12)}…)`)
            opts.onSessionTakenOver?.(byPeer)
          })()
        },
      })
    } catch (e: any) {
      log(`self-topic unavailable (${e?.message ?? e}) — running without the §9.1 takeover rule`)
    }
  }

  return {
    self,
    async open(peer: Peer, roomOpts: RoomOpts) {
      return openRoom(id, peer, node, self, params, roomOpts, {
        log,
        onIsolated: () => { setLink('reconnecting'); void reconnect(true) },
        ensureConnected: async () => { if (!connected()) await reconnect() },
        register: (r: OpenRoom) => { rooms.add(r); return () => rooms.delete(r) },
      })
    },
    async refresh() {
      if (!connected()) { log('back with no relay connection — re-dialing'); await reconnect() }
      for (const r of rooms) { r.refresh(); r.flushPending() }
    },
    setOffline(offline: boolean) {
      if (offline) {
        log('the platform reports no network')
        setLink('offline')
        return
      }
      log('the platform reports the network is back — re-dialing')
      void reconnect(true)
    },
    close: () => shutdown('closed by the app'),
  }
}

/** What a room needs from the session that owns its transport. */
interface RoomHost {
  log: (m: string, level?: 'info' | 'debug') => void
  onIsolated: () => void
  ensureConnected: () => Promise<void>
  register: (r: { refresh(): void; flushPending(): void; stop(): void; sendPresence(s: any): void }) => () => void
}

/**
 * Join one room on an existing transport, and run the typing/away/leave presence
 * machine. The UI only renders (via the on* callbacks) and feeds intent.
 */
async function openRoom(
  id: Identity, peer: Peer, node: any, self: string, params: RoomParams, opts: RoomOpts, host: RoomHost,
): Promise<Conversation> {
  const log = opts.onLog ?? host.log
  log(`opening conversation: network=${params.networkId} date=${params.dateUTC} eh2=${!!opts.eh2} webrtc=${!!opts.webrtc}`)
  // In EH-2 mode the WebRTC offer cannot go out before the session exists —
  // signaling rides the room encrypted. So the plane is kicked when the
  // handshake completes, not (only) when presence says the peer joined.
  let plane: WebRTCPlane | null = null
  const onSecurity: Eh2Options['onState'] = (p, state) => {
    log(`security: ${state} with ${p.slice(0, 12)}…`)
    opts.onSecurity?.(p, state)
    if (state === 'established') plane?.onPeer(p)
  }
  const { topic, keys } = await deriveRoom(id, peer, params, opts.eh2 ? { onState: onSecurity } : false)
  log(`room derived: topic ${topic.slice(0, 16)}…`)

  const room = joinChat(node, topic, keys, {
    onMessage: opts.onMessage,
    onTyping: opts.onTyping,
    // In EH-2 mode the plane is kicked from onSecurity instead (see above) —
    // signaling needs a session, which presence 'join' does not imply.
    onPresence: (p, ev) => { opts.onPresence?.(p, ev); if (ev === 'join' && !opts.eh2) plane?.onPeer(p) },
    onReaction: opts.onReaction,
    onFile: opts.onFile,
    onSignal: (from, env) => plane?.onSignal(from, env),
    // The peer reloaded: rebind the data plane onto the PeerId that is alive.
    onPeerReplaced: (old, now) => { log(`peer ${old.slice(0, 12)}… is now ${now.slice(0, 12)}… — rebinding the data plane`); plane?.onPeer(now) },
    heartbeatMs: opts.heartbeatMs,
    onLog: opts.onLog,
    onDelivered: (mid, ms) => { log(`delivered ${mid} in ${ms} ms`); opts.onDelivered?.(mid, ms) },
    onUndelivered: (mid) => { log(`UNDELIVERED ${mid} — peer never confirmed`); opts.onUndelivered?.(mid) },
    onLateDelivered: (mid, ms) => { log(`late: ${mid} arrived after all, ${Math.round(ms / 1000)}s`); opts.onLateDelivered?.(mid, ms) },
    onStall: () => plane?.demote(),
    // Heartbeats reaching nobody is the honest signal that the transport is
    // dead — `getConnections()` still reports a connection nothing has tried to
    // write to, which is why an offline tab used to look perfectly healthy.
    onIsolated: host.onIsolated,
    onForeign: (p) => { log(`foreign peer in the room: ${p.slice(0, 12)}… — its handshake does not verify`); opts.onForeign?.(p) },
  })
  if (opts.webrtc) plane = attachWebRTC(room, self, { onState: (st) => { log(`webrtc: ${st}`); opts.onWebrtcState?.(st) } })
  const unregister = host.register(room)

  let typingSent = false
  let away = false
  let tT: any
  let aT: any
  const stopTyping = () => { clearTimeout(tT); if (typingSent) { typingSent = false; room.sendTyping('stop') } }
  const armAway = () => { clearTimeout(aT); aT = setTimeout(() => { away = true; stopTyping(); room.sendPresence('away') }, AWAY_MS) }
  const noteActivity = () => {
    if (away) { away = false; room.sendPresence('active') }
    if (!typingSent) { typingSent = true; room.sendTyping('start') }
    clearTimeout(tT); tT = setTimeout(stopTyping, TYPING_STOP_MS)
    armAway()
  }
  const noteAway = () => { stopTyping(); clearTimeout(aT); if (!away) { away = true; room.sendPresence('away') } }

  return {
    peerId: self,
    topic,
    sendText: (body) => { const mid = room.sendText(body); stopTyping(); return mid },
    resend: (mid) => room.resend(mid),
    sendReaction: (toId, emoji) => room.sendReaction(toId, emoji),
    noteActivity,
    noteAway,
    refresh: async () => {
      // A tab that was hidden for a while may come back with its transport dead:
      // throttling turns into freezing (laptop asleep, app in the background)
      // and the relay connection goes with it. Nothing downstream notices, so
      // the room looks alive while nothing can leave it.
      await host.ensureConnected()
      room.refresh()
      room.flushPending()
      if (away) { away = false; room.sendPresence('active') }
    },
    who: () => room.who(),
    secured: () => room.secured(),
    leave: async () => {
      log(`leaving room ${topic.slice(0, 12)}…`)
      clearTimeout(tT); clearTimeout(aT)
      unregister()
      try { room.sendPresence('leave') } catch {}
      await new Promise((r) => setTimeout(r, FLUSH_MS))
      try { plane?.stop() } catch {}
      try { room.stop() } catch {}
    },
  }
}

/**
 * One conversation on a transport of its own — the shape everything used before
 * sessions existed, kept for the CLI and the tests. `leave()` takes the whole
 * session with it, which is what a single-room caller means by leaving.
 */
export async function openConversation(id: Identity, peer: Peer, opts: OpenOpts): Promise<Conversation> {
  const session = await startSession(id, {
    relay: opts.relay,
    transport: opts.transport,
    broker: opts.broker,
    params: opts.params,
    onLog: opts.onLog,
    onLink: opts.onLink,
    onSessionTakenOver: opts.onSessionTakenOver,
  })
  const conv = await session.open(peer, opts)
  return {
    ...conv,
    refresh: () => session.refresh(),
    leave: async () => { await conv.leave(); await session.close() },
  }
}
