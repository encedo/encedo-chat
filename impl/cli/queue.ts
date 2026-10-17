/**
 * queue.ts - the daemon's outbox, persisted and driven (CLI-PLAN.md stage 4b).
 *
 * outbox.ts decides; this keeps it on disk (sealed under the identity's §10
 * key, like the invites - `ec-outbox-<kid>`) and drives it: a notification for
 * somebody online goes now (unless its key is inside its window), one for
 * somebody offline is queued, and the queue is flushed the moment presence
 * says they are back, and checked every 30 s (expiry, and any missed event).
 *
 * No duplicates: a message handed to a room that was not confirmed in time is
 * still in that room's resend loop, so its entry is marked in flight and leaves
 * the queue when its ack arrives, instead of being sent a second time.
 *
 * But the room's loop GIVES UP (its budget runs only while the peer announces;
 * a phone asleep in the background stops announcing), and an entry in flight
 * was never offered again: a report sat "queued" for hours next to a contact
 * that was online (bs2-bot -> antek3a, 2026-10-17). So an entry in flight for
 * RESEND_AFTER_MS is re-sent UNDER ITS OWN ID (`room.resend`, no duplicate on
 * the other side) whenever its recipient is online; if the room does not know
 * the id any more (false for LOST_AFTER_MS), it is sent again as new.
 */

import { readSealedKV, writeSealedKV, SALTS } from '../lib/sealedstore.ts'
import type { Names } from '../lib/storenames.ts'
import type { KV } from '../lib/migrate.ts'
import { Outbox, outgoingText, type Entry } from './outbox.ts'
import type { Hub } from './hub.ts'

export const OUTBOX_SALT = SALTS.outbox

export const RESEND_AFTER_MS = 60_000
export const LOST_AFTER_MS = 10 * 60_000

export interface Submitted { ok: true; status: 'delivered' | 'queued' | 'merged'; to: string; id?: string; ms?: number; qid?: string }

export class Queue {
  private hub: Hub; private kv: KV; private base: Uint8Array | null; private names: Names
  private log: (m: string) => void
  outbox = new Outbox()
  /** message id -> the entry it carries, its recipient, since when (or since the last re-send). */
  private inflight = new Map<string, { qid: string; pub: string; since: number; first: number }>()
  private now: () => number
  private flushing = new Set<string>()
  private timer: any = null

  constructor(o: { hub: Hub; kv: KV; base: Uint8Array | null; names: Names; log?: (m: string) => void; now?: () => number }) {
    this.hub = o.hub; this.kv = o.kv; this.base = o.base; this.names = o.names; this.log = o.log ?? (() => {})
    this.now = o.now ?? Date.now
  }

  private fly(id: string, qid: string, pub: string) { const t = this.now(); this.inflight.set(id, { qid, pub, since: t, first: t }) }
  private flying(qid: string): [string, { qid: string; pub: string; since: number; first: number }] | undefined {
    for (const kv of this.inflight) if (kv[1].qid === qid) return kv
  }

  async load() {
    const v = await readSealedKV<Entry[]>(this.kv, this.base, this.names, 'outbox', Array.isArray)
    this.outbox = new Outbox(Array.isArray(v) ? v : [])
    this.hub.on((e) => {
      if (e.t === 'presence' && e.state === 'online') void this.flush(e.pub)
      if (e.t === 'delivered') {
        const qid = this.inflight.get(e.id)?.qid; if (!qid) return
        this.inflight.delete(e.id)
        const entry = this.outbox.entries.find((x) => x.qid === qid)
        if (entry) { this.outbox.delivered(entry, this.now()); void this.save(); this.log(`z kolejki doręczono do ${e.to}`) }
      }
    })
    this.timer = setInterval(() => void this.tick(), 30_000); this.timer.unref?.()
    await this.tick()
    if (this.outbox.entries.length) this.log(`w kolejce: ${this.outbox.entries.length}`)
  }
  stop() { clearInterval(this.timer) }
  save() { return writeSealedKV(this.kv, this.base, this.names, 'outbox', this.outbox.entries) }

  private async tick() {
    const gone = this.outbox.expire(this.now())
    for (const g of gone) this.log(`przeterminowane, nie wysłane: do ${this.hub.nameOf(g.to)} „${g.text.slice(0, 40)}”`)
    if (gone.length) await this.save()
    for (const pub of new Set(this.outbox.entries.map((e) => e.to))) if (this.hub.online.has(pub)) await this.flush(pub)
  }

  /** Send what is due to `pub`, oldest first; stop at the first that is not confirmed. */
  async flush(pub: string) {
    if (this.flushing.has(pub)) return
    this.flushing.add(pub)
    try {
      for (const e of this.outbox.due(pub, this.now())) {
        const fl = this.flying(e.qid)
        if (fl) {
          const [id, rec] = fl, t = this.now()
          if (t - rec.since < RESEND_AFTER_MS) continue
          if (await this.hub.resend(pub, id)) { rec.since = t; this.log(`ponawiam do ${this.hub.nameOf(pub)} (bez potwierdzenia od ${Math.round((t - rec.first) / 1000)} s)`); continue }
          // false = still trying (fine) or an id the room no longer knows (lost)
          if (t - rec.first < LOST_AFTER_MS) continue
          this.inflight.delete(id)
          this.log(`do ${this.hub.nameOf(pub)}: rozmowa nie zna już wiadomości - wysyłam od nowa`)
        }
        const r = await this.hub.send(pub, outgoingText(e), 20_000)
        if (r.status === 'delivered') { this.outbox.delivered(e, this.now()); await this.save(); this.log(`z kolejki doręczono do ${r.to}`) }
        else { this.fly(r.id, e.qid, pub); break }
      }
    } finally { this.flushing.delete(pub) }
  }

  async submit(who: string, text: string, o: { waitMs: number; ttlMs?: number; key?: string }): Promise<Submitted | any> {
    // A group has no acks and no presence to wait for: it goes now, never queued.
    if (this.hub.groups?.byName(who)) return { ok: true, ...(await this.hub.send(who, text, o.waitMs)) }
    const c = this.hub.find(who); if (!c) throw new Error(`nie ma kontaktu ani grupy „${who}”`)
    const now = this.now()
    // Goes now when they are online, its key is outside its window, and nothing
    // DUE is waiting for them (it must not overtake those). An entry only
    // waiting for its own key's window does not hold up unrelated messages.
    if (this.hub.online.has(c.pub) && !this.outbox.throttled(c.pub, o.key, now) && !this.outbox.due(c.pub, now).length) {
      const r = await this.hub.send(c.pub, text, o.waitMs)
      if (r.status === 'delivered') { this.outbox.delivered({ to: c.pub, key: o.key }, this.now()); return { ok: true, ...r } }
      // Not confirmed: it is in the room's resend loop - queue it as in flight, not a second copy.
      const { entry } = this.outbox.add(c.pub, text, { now, ttlMs: o.ttlMs, key: o.key })
      this.fly(r.id, entry.qid, c.pub); await this.save()
      return { ok: true, status: 'queued', to: c.name, id: r.id, qid: entry.qid }
    }
    const { entry, how, dropped } = this.outbox.add(c.pub, text, { now, ttlMs: o.ttlMs, key: o.key })
    for (const d of dropped) this.log(`kolejka do ${c.name} pełna - wypada najstarsze: „${d.text.slice(0, 40)}”`)
    await this.save()
    if (this.hub.online.has(c.pub)) void this.flush(c.pub)   // throttled now, due when its window ends
    return { ok: true, status: how, to: c.name, qid: entry.qid }
  }

  list() {
    const now = this.now()
    return this.outbox.entries.map((e) => ({ to: this.hub.nameOf(e.to), age_s: Math.round((now - e.created) / 1000), expires_in_s: Math.round((e.expires - now) / 1000), key: e.key, merged: e.merged, text: e.text }))
  }
}
