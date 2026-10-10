/**
 * regioncheck.ts - is this client in a region where onchato is not provided?
 *
 * Nodes answer clients from the sanctions list (GEOBLOKADA.md) with HTTP 451,
 * on every path - including the relay's WebSocket. A refused WebSocket tells a
 * page nothing (no status, no body), so a blocked client would only ever see
 * "no connection". When the relays will not have us, the front-ends ask this:
 * one plain GET of `/health` on a node, whose 451 carries CORS so the status is
 * readable from the app's origin. A node that is merely down, or that answers
 * normally (no CORS on a 200, so fetch throws), reads as "not blocked" - this
 * says yes only on an explicit 451.
 */

export async function regionBlocked(
  hosts: string[],
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const f = o.fetch ?? fetch
  for (const host of [...new Set(hosts)].slice(0, 3)) {
    try {
      const r = await f(`https://${host}/health`, { cache: 'no-store', signal: AbortSignal.timeout(o.timeoutMs ?? 6000) })
      if (r.status === 451) return true
    } catch { /* down, offline, or a normal answer without CORS: not a refusal */ }
  }
  return false
}
