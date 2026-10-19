/**
 * allowlist.mjs - who may connect to a node of a network whose profile says
 * `policy.access: "allowlist"` (OPERATOR-NODE-PLAN.md, access tier B).
 *
 * Each identity in such a network keeps a stable libp2p key, so its PeerId is
 * stable; the node lets in only PeerIds on its list, checked right after the
 * Noise handshake (so the peer has proven it holds the key - nothing secret
 * travels, nothing lands in a log). The other relays of the mesh (--siblings,
 * --peers) are always let in. Without --allow-peers nothing here runs: the
 * public network and open networks are as they were.
 *
 *   file = one entry per line: "<PeerId> [label...]"; "#" starts a comment.
 *   The label is the administrator's note; the node never needs it.
 */
import { readFileSync, statSync } from 'node:fs'

const PEER_ID = /^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/

/** The PeerIds in a list file's text; lines that are not one are reported, not trusted. */
export function parseAllowlist(text) {
  const ids = new Set(), bad = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const id = line.split(/\s+/)[0]
    if (PEER_ID.test(id)) ids.add(id); else bad.push(i + 1)
  }
  return { ids, bad }
}

/** Refuse this peer? Siblings always in; everyone else only when listed. */
export function refuse(peerId, allowed, siblings) {
  const id = String(peerId)
  return !siblings.has(id) && !allowed.has(id)
}

/**
 * The list, read now and again whenever the file changes (checked every
 * `everyMs`). `onChange(ids)` is called after each reload with the new set,
 * so the caller can close connections of peers that were taken off it.
 * A file that disappears or cannot be read keeps the LAST list - an editor
 * replacing the file must not open the node to everyone, nor close it to all.
 */
export function watchAllowlist(path, { everyMs = 2000, log = console.log, onChange = () => {} } = {}) {
  let allowed = new Set(), mtime = -1
  const load = () => {
    let m
    try { m = statSync(path).mtimeMs } catch { if (mtime !== 0) log(`[warn] allowlist: ${path} is missing - keeping the last list (${allowed.size})`); mtime = 0; return }
    if (m === mtime) return
    try {
      const { ids, bad } = parseAllowlist(readFileSync(path, 'utf8'))
      allowed = ids; mtime = m
      log(`[ok] allowlist: ${ids.size} device(s) from ${path}${bad.length ? ` - ignored line(s) ${bad.join(', ')}` : ''}`)
      onChange(ids)
    } catch (e) { log(`[warn] allowlist: could not read ${path}: ${e?.message ?? e} - keeping the last list`) }
  }
  load()
  const t = setInterval(load, everyMs); t.unref?.()
  return { has: (id) => allowed.has(String(id)), get ids() { return allowed }, stop: () => clearInterval(t) }
}
