/**
 * hemaddr.ts - the HEM address the sign-in form starts with.
 *
 * The last address a device answered on (a check-in passed), so a HEM at an
 * address of its own does not have to be retyped after every sign-out; the
 * public my.ence.do when nothing is remembered. Kept unsealed: it is needed
 * before the password. It names the device to anyone who opens this browser -
 * the same as `ec-hem-net-<KID>` beside it already does.
 */

export const HEM_ADDR_KEY = 'ec-hem-url'
export const HEM_ADDR_DEFAULT = 'https://my.ence.do'

type KV = Pick<Storage, 'getItem' | 'setItem'>

/** The address to show: the remembered one, or the default. Never throws. */
export function lastHemAddr(kv: KV): string {
  try { return kv.getItem(HEM_ADDR_KEY)?.trim() || HEM_ADDR_DEFAULT } catch { return HEM_ADDR_DEFAULT }
}

/** Remember the address a device answered on. A blocked storage costs only the convenience. */
export function rememberHemAddr(kv: KV, url: string): void {
  const u = url.trim()
  if (!u) return
  try { kv.setItem(HEM_ADDR_KEY, u) } catch { /* private window, quota: the default comes back */ }
}
