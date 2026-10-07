/**
 * groupview.ts - two facts about a group that the protocol cannot show and the
 * member list has to, kept out of app.ts so they can be tested without a DOM.
 *
 * 1. Who in the roster is NOT one of my contacts. Sender keys ride 1:1
 *    conversations (PROTOCOL.md §8.3), and this app opens a 1:1 only with a
 *    contact, so such a member and I cannot read each other in the group - in
 *    either direction - while everybody else can. Reported 2026-10-06: a member
 *    showed as "wv7z1yc+" (eight characters of a key) with nothing saying why.
 *
 * 2. Whom I, the admin, still owe an invitation. An invitation is a group-skd
 *    over 1:1 and nothing stores it for an absent recipient, so it waited in
 *    memory and died with a reload: a member offline at creation never learned
 *    the group existed (reported 2026-10-06, a phone). The owed list is kept
 *    with the group (§10 cache) and cleared by the one confirmation the protocol
 *    already has - a member who received the group hands ME its own sender key
 *    for it (§8.3), so its group-skd arriving at the current epoch IS the
 *    receipt. No new message, no ack: nothing changes on the wire.
 */

export interface Member { pub: string }

/** Members who are neither me nor in my contacts, in roster order. */
export function foreignMembers(members: Member[], self: string | undefined, contacts: Set<string>): string[] {
  return members.map((m) => m.pub).filter((p) => p !== self && !contacts.has(p))
}

/**
 * The invitations an admin still owes, per group. Epoch-scoped: a rekey makes
 * every member owed again, and a receipt counts only at the epoch it was owed
 * for - a key a member sent for an OLD epoch says nothing about the new one.
 */
export class OwedInvites {
  private owed = new Map<string, { epoch: number; pubs: Set<string> }>()

  /** I (the admin) just invited `pubs` to `gid` at `epoch`. A newer epoch replaces. */
  invite(gid: string, epoch: number, pubs: string[]): void {
    const cur = this.owed.get(gid)
    if (cur && cur.epoch > epoch) return
    const set = cur && cur.epoch === epoch ? cur.pubs : new Set<string>()
    for (const p of pubs) set.add(p)
    this.owed.set(gid, { epoch, pubs: set })
  }

  /** `from` handed me its sender key for `gid` at `epoch`. True when that settled a debt. */
  receipt(gid: string, from: string, epoch: number): boolean {
    const cur = this.owed.get(gid)
    if (!cur || epoch < cur.epoch || !cur.pubs.has(from)) return false
    cur.pubs.delete(from)
    if (!cur.pubs.size) this.owed.delete(gid)
    return true
  }

  isOwed(gid: string, pub: string): boolean { return !!this.owed.get(gid)?.pubs.has(pub) }
  owedFor(gid: string): string[] { return [...(this.owed.get(gid)?.pubs ?? [])] }
  /** Every (group, member) still waiting, for a re-send when `pub` shows up. */
  groupsOwing(pub: string): string[] { return [...this.owed].filter(([, v]) => v.pubs.has(pub)).map(([g]) => g) }
  forget(gid: string): void { this.owed.delete(gid) }

  /** What goes into the group's sealed cache blob. */
  toJSON(gid: string): { epoch: number; pubs: string[] } | undefined {
    const cur = this.owed.get(gid)
    return cur ? { epoch: cur.epoch, pubs: [...cur.pubs] } : undefined
  }
  /** Back from the blob; anything malformed is ignored rather than trusted. */
  load(gid: string, v: unknown): void {
    const o = v as { epoch?: unknown; pubs?: unknown } | null
    if (!o || typeof o.epoch !== 'number' || !Array.isArray(o.pubs)) return
    const pubs = o.pubs.filter((p): p is string => typeof p === 'string')
    if (pubs.length) this.owed.set(gid, { epoch: o.epoch, pubs: new Set(pubs) })
  }
}
