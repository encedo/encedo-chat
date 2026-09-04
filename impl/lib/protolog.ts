/**
 * protolog.ts — narrate the protocol so an implementation can be read against
 * the spec.
 *
 * The engine already narrates its *transport* (`onLog` in room/core/grouproom:
 * who joined, which topic, whether a publish reached anyone). This is the layer
 * under that: the derivations and state transitions §5–§8 describe — which key
 * came from which input, which handshake stage produced which transcript hash,
 * when a chain advanced and to what.
 *
 * **Two switches, and the difference between them is the point.**
 *
 *   `events` — stages, transitions, counters, sizes. Says WHAT happened.
 *   `keys`   — the actual secret bytes. Says what it happened WITH.
 *
 * They are separate because a debug console ends up pasted into a bug report.
 * Everything under `events` is safe to hand to somebody; everything under `keys`
 * is the conversation itself, and a transcript plus a root key is the whole of
 * it. Turning the second on is therefore a deliberate act, never a side effect
 * of the first.
 *
 * Both are OFF unless a front-end turns them on, and neither exists in a build
 * that never calls `enableProtoLog` — the calls compile to a flag test.
 *
 * What this cannot leak, however it is set: anything inside the HEM. An IK's
 * private half never reaches this process, so what prints here is what the
 * client already holds — ephemeral material, chain keys, and the shared secrets
 * derived from a device call. That is exactly the material §7's forward secrecy
 * is designed to make worthless a moment later, which is why showing it during
 * R&D costs little; it is also why this must not ship enabled.
 *
 * And what it will not show even with `keys` on: a `CryptoKey` imported
 * non-extractable — the announce MAC key, every AEAD key. There is no way to
 * read those back and that is the point of importing them that way, so the
 * traces print the RAW bytes at the moment of derivation, one line before they
 * become a key object. Anything the process cannot see, the log does not invent.
 */

let showEvents = false
let showKeys = false
let sink: (line: string) => void = (line) => console.log(line)

/** Turn narration on. `keys` additionally prints secret material — see above. */
export function enableProtoLog(opts: { events?: boolean; keys?: boolean; sink?: (line: string) => void } = {}): void {
  showEvents = opts.events ?? true
  showKeys = opts.keys ?? false
  if (opts.sink) sink = opts.sink
  if (showKeys) sink('[proto] KEY MATERIAL WILL BE PRINTED — debug builds only, never a shipped one')
}

export const protoLogOn = () => showEvents
export const protoKeysOn = () => showKeys

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * A value as it should appear in a trace: full bytes when `keys` is on, and a
 * length with a short digest-like head when it is not — enough to see that two
 * sides derived the SAME thing without publishing what it is.
 */
const FULL_MAX = 64 // every secret in §5–§8 is 32 B; past this it is a public blob
export function val(v: Uint8Array | string | number | undefined | null): string {
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return showKeys ? v : `«${v.length} chars»`
  if (!showKeys) return `«${v.length}B ${hex(v.slice(0, 4))}...»`
  // Long values are ML-KEM public keys and ciphertexts — over a kilobyte each,
  // not secret, and they bury the 32-byte material the reader came for. Every
  // key, hash and MAC in the protocol prints whole.
  return v.length <= FULL_MAX ? hex(v) : `${hex(v.slice(0, 8))}...${hex(v.slice(-8))} (${v.length}B)`
}

/** One narration line, tagged with the section of the protocol it belongs to. */
export function plog(tag: string, msg: string): void {
  if (!showEvents) return
  sink(`[${tag}] ${msg}`)
}
