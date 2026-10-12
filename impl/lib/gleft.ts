/**
 * gleft.ts - the groups this identity walked out of, and at which epoch.
 *
 * Leaving a group is local: nothing goes on the wire (PROTOCOL.md 8.3), so
 * the admin keeps distributing to the roster it still holds, and the other
 * members keep re-sending their keys. Dropping the record and the sealed blob
 * (the 2026-10-12 audit found neither was dropped - the group came back on
 * the next reload with its secret) is half of leaving; the other half is not
 * being talked back in by a copy of the epoch one already left. A key handed
 * over at a NEWER epoch is a fresh distribution by the admin's rekey, and
 * joining on it is the ordinary automatic join every group has.
 *
 * Sealed under the identity (PROTOCOL.md 10, `encedo-chat-group-left-v1`):
 * a list of group ids is a list of relationships.
 */

export const LEFT_SALT = 'encedo-chat-group-left-v1'
export const LEFT_PREFIX = 'ec-gleft-'
/** Enough for a lifetime of leaving; the oldest entries go first past it. */
export const LEFT_MAX = 256

/** gid (hex) -> the epoch the identity was at when it left. */
export type LeftMap = Record<string, number>

export const isLeftMap = (v: unknown): v is LeftMap =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v as any).every((e) => Number.isInteger(e) && e >= 0)

/** Record a departure; returns the map to store (a new object, capped). */
export function markLeft(map: LeftMap, gidHex: string, epoch: number, max = LEFT_MAX): LeftMap {
  const next: LeftMap = { ...map, [gidHex]: Math.max(epoch, map[gidHex] ?? 0) }
  const keys = Object.keys(next)
  for (let i = 0; keys.length - i > max; i++) delete next[keys[i]]
  return next
}

/** True when an SKD at `epoch` is a copy of a group already left at that epoch or later. */
export function leftCovers(map: LeftMap, gidHex: string, epoch: number): boolean {
  const at = map[gidHex]
  return at !== undefined && epoch <= at
}

/** Joined again at a newer epoch (or by the admin re-adding us): forget the departure. */
export function unmarkLeft(map: LeftMap, gidHex: string): LeftMap {
  if (!(gidHex in map)) return map
  const next = { ...map }; delete next[gidHex]; return next
}
