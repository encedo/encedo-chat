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
import { attachWebRTC, type WebRTCPlane } from '../net/webrtc-plane.ts'
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

const TYPING_STOP_MS = 4_000 // stop "typing" after this idle gap
const AWAY_MS = 60_000 // go "away" after this much no activity
const FLUSH_MS = 250 // let the leave reach the relay before teardown

export interface OpenOpts extends ChatOpts {
  relay: string
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
}
export interface Conversation {
  peerId: string
  topic: string
  sendText(body: string): string // returns the sent message id (for reactions)
  sendReaction(toId: string, emoji: string): void
  noteActivity(): void // UI calls on user input → drives "typing" + resets "away"
  noteAway(): void // UI calls on blur/tab-hidden → "away" now
  refresh(): void // UI calls when the tab becomes visible again (timers were throttled)
  who(): string[]
  secured(): string[] // peers with a live EH-2 ratchet (empty in interim mode)
  leave(): Promise<void> // presence:leave last-will + clean transport stop
}

/**
 * Open a live conversation: derive room → create peer + dial relay → join, and
 * run the typing/away/leave presence machine. The UI only renders (via the
 * on* callbacks) and feeds intent (sendText / noteActivity / leave).
 */
export async function openConversation(id: Identity, peer: Peer, opts: OpenOpts): Promise<Conversation> {
  const log = opts.onLog ?? (() => {})
  const params = opts.params ?? { networkId: 'main', dateUTC: todayUTC() }
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
  const node = await createPeer()
  const dialT0 = Date.now()
  await dial(node, opts.relay)
  log(`relay dialed in ${Date.now() - dialT0} ms as ${node.peerId.toString().slice(0, 12)}…`)

  const self = node.peerId.toString()
  const room = joinChat(node, topic, keys, {
    onMessage: opts.onMessage,
    onTyping: opts.onTyping,
    // In EH-2 mode the plane is kicked from onSecurity instead (see above) —
    // signaling needs a session, which presence 'join' does not imply.
    onPresence: (p, ev) => { opts.onPresence?.(p, ev); if (ev === 'join' && !opts.eh2) plane?.onPeer(p) },
    onReaction: opts.onReaction,
    onFile: opts.onFile,
    onSignal: (from, env) => plane?.onSignal(from, env),
    heartbeatMs: opts.heartbeatMs,
    onLog: opts.onLog,
    onDelivered: (id, ms) => { log(`delivered ${id} in ${ms} ms`); opts.onDelivered?.(id, ms) },
    onUndelivered: (id) => { log(`UNDELIVERED ${id} — peer never confirmed`); opts.onUndelivered?.(id) },
    onStall: () => plane?.demote(),
  })
  if (opts.webrtc) plane = attachWebRTC(room, self, { onState: (st) => { log(`webrtc: ${st}`); opts.onWebrtcState?.(st) } })

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
    peerId: node.peerId.toString(),
    topic,
    sendText: (body) => { const id = room.sendText(body); stopTyping(); return id },
    sendReaction: (toId, emoji) => room.sendReaction(toId, emoji),
    noteActivity,
    noteAway,
    refresh: () => { room.refresh(); if (away) { away = false; room.sendPresence('active') } },
    who: () => room.who(),
    secured: () => room.secured(),
    leave: async () => {
      clearTimeout(tT); clearTimeout(aT)
      try { room.sendPresence('leave') } catch {}
      await new Promise((r) => setTimeout(r, FLUSH_MS))
      try { plane?.stop() } catch {}
      try { room.stop() } catch {}
      try { await node.stop() } catch {}
    },
  }
}
