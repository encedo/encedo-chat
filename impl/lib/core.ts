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
import { joinChat, type RoomKeys, type ChatOpts } from './room.ts'
import { createPeer, dial } from '../net/peer.ts'
import { b64, unb64 } from './wc.ts'

export interface Identity {
  handle: string
  pub: string // base64
  ecdh(peerPubB64: string): Promise<Uint8Array> // raw 32-byte shared secret
}
export type RoomParams = RvParams

/** Build an Identity from an already-authenticated HEM session (browser-safe — no fs). */
export function hemIdentityFrom(hem: any, kid: string, handle: string, pub: string): Identity {
  return {
    handle,
    pub,
    async ecdh(peerPubB64: string) {
      const t = await hem.authorizePassword(null, `keymgmt:use:${kid}`) // cached derived key → no re-prompt
      return hem.ecdh(t, kid, peerPubB64)
    },
  }
}

// ---- contact book (peer pubkeys) ----------------------------------------
export interface Contact { name: string; pub: string; kid?: string }
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
      for (const k of keys) {
        const useTok = await hem.authorizePassword(null, `keymgmt:use:${k.kid}`)
        const { pubkey } = await hem.getPubKey(useTok, k.kid)
        out.push({ name: peerNameFromDescr(k.description), pub: pubkey, kid: k.kid })
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

/** Derive the day's room for a pair: topic + interim keys (macKey + Session). */
export async function deriveRoom(id: Identity, peerPubB64: string, p: RoomParams): Promise<{ topic: string; keys: RoomKeys }> {
  const ss = await id.ecdh(peerPubB64)
  const topic = await topicFromSecret(ss, p)
  const keys = { macKey: await announceMacKey(ss, p), session: await interimSession(ss, p) }
  return { topic, keys }
}

const TYPING_STOP_MS = 4_000 // stop "typing" after this idle gap
const AWAY_MS = 60_000 // go "away" after this much no activity
const FLUSH_MS = 250 // let the leave reach the relay before teardown

export interface OpenOpts extends ChatOpts {
  relay: string
  params?: RoomParams
}
export interface Conversation {
  peerId: string
  topic: string
  sendText(body: string): void
  sendReaction(toId: string, emoji: string): void
  noteActivity(): void // UI calls on user input → drives "typing" + resets "away"
  noteAway(): void // UI calls on blur/tab-hidden → "away" now
  who(): string[]
  leave(): Promise<void> // presence:leave last-will + clean transport stop
}

/**
 * Open a live conversation: derive room → create peer + dial relay → join, and
 * run the typing/away/leave presence machine. The UI only renders (via the
 * on* callbacks) and feeds intent (sendText / noteActivity / leave).
 */
export async function openConversation(id: Identity, peerPubB64: string, opts: OpenOpts): Promise<Conversation> {
  const params = opts.params ?? { networkId: 'main', dateUTC: todayUTC() }
  const { topic, keys } = await deriveRoom(id, peerPubB64, params)
  const node = await createPeer()
  await dial(node, opts.relay)

  const room = joinChat(node, topic, keys, {
    onMessage: opts.onMessage,
    onTyping: opts.onTyping,
    onPresence: opts.onPresence,
    onReaction: opts.onReaction,
    onFile: opts.onFile,
    heartbeatMs: opts.heartbeatMs,
  })

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
    sendText: (body) => { room.sendText(body); stopTyping() },
    sendReaction: (toId, emoji) => room.sendReaction(toId, emoji),
    noteActivity,
    noteAway,
    who: () => room.who(),
    leave: async () => {
      clearTimeout(tT); clearTimeout(aT)
      try { room.sendPresence('leave') } catch {}
      await new Promise((r) => setTimeout(r, FLUSH_MS))
      try { room.stop() } catch {}
      try { await node.stop() } catch {}
    },
  }
}
