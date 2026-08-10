/**
 * hemwrap.ts — two transparent layers over a `HEM` instance: one that remembers
 * public keys, one that narrates what is being asked of the device.
 *
 * They live here rather than in the web app because they are not UI, and because
 * of the bug that produced this file. Composed as `traceHem(cachePubKeys(hem))`
 * the app broke with *"can't access private field or method: object is not the
 * right class"* — the inner proxy handed back an UNBOUND method, the outer one
 * applied it with the proxy as `this`, and the SDK's `#private` fields are not
 * reachable that way. It was invisible to every test because it only existed in
 * a file no test can import.
 *
 * **The rule both layers keep: a method handed out is bound to the real object.**
 * Then it does not matter how many layers wrap it, or what `this` a caller
 * supplies — the SDK always runs as itself.
 */

/**
 * Remember a public key under its KID for the lifetime of this wrapper.
 *
 * `KID = SHA-1(pub)[0:16]` is a hash of the key's own content, so the answer
 * cannot change while the entry exists — and the current firmware does not
 * return public keys from `key_search`, so the contact book pays one `getPubKey`
 * per contact on every load. A trace of one sign-in fetched the same key three
 * times, at about a second each.
 *
 * The PROMISE is cached, so callers that want the same key while the device is
 * working share the call. A failure is not remembered.
 */
export function cachePubKeys(hem: any): any {
  const byKid = new Map<string, Promise<any>>()
  return new Proxy(hem, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function') return v
      if (prop !== 'getPubKey') return v.bind(target)
      return (token: string, kid: string, ...rest: any[]) => {
        const k = String(kid).toLowerCase()
        let p = byKid.get(k)
        if (!p) {
          p = v.apply(target, [token, kid, ...rest])
          p!.catch(() => byKid.delete(k))
          byKid.set(k, p!)
        }
        return p
      }
    },
  })
}

/** Anything answering faster than this was answered locally — no round trip is. */
const CACHED_MS = 5
/** Worth reporting how long it took; below this the question alone is enough. */
const SLOW_MS = 500

const kidish = (v: any) => typeof v === 'string' ? v.slice(0, 12) + (v.length > 12 ? '…' : '') : '?'

/**
 * What each SDK call is FOR, in the words someone debugging would use.
 *
 * **Nothing secret is printed.** The arguments are picked per method, never
 * dumped: `authorizePassword` shows its SCOPE and not its first argument, an
 * import shows a label and not the bytes, a KID is truncated, and no token
 * appears anywhere. The SDK's own `debug` flag prints headers and bodies, which
 * is why it is not what this turns on.
 */
const CALLS: Record<string, (a: any[]) => string> = {
  hemCheckin: () => 'checkin (clock sync + connection test)',
  getVersion: () => 'device version',
  getStatus: () => 'device status',
  getAttestation: () => 'device attestation',
  authorizePassword: (a) => `access token for scope ${a[1]}`,
  authorizeRemote: (a) => `remote access token for scope ${a[0]}`,
  listKeys: () => 'key list',
  searchKeys: (a) => `key search "${a[1]}"`,
  getPubKey: (a) => `public key of KID=${kidish(a[1])}`,
  createKeyPair: (a) => `new ${a[2]} key pair, label "${a[1]}"`,
  importPublicKey: (a) => `import of ${a[2]} public key, label "${a[1]}"`,
  updateKey: (a) => `update of KID=${kidish(a[1])} → label "${a[2]}"`,
  deleteKey: (a) => `delete of KID=${kidish(a[1])}`,
  ecdh: (a) => `ECDH: KID=${kidish(a[1])} × a peer public key`,
  ecdhKid: (a) => `ECDH: KID=${kidish(a[1])} × KID=${kidish(a[2])}`,
  deriveKey: (a) => `derived key, label "${a[1]}"`,
}

export interface TraceSink { (msg: string, kind: 'req' | 'cached' | 'slow' | 'error'): void }

/**
 * Narrate the conversation with the device. Answers are not echoed line for
 * line, or the questions would be buried: a call is reported when it is issued,
 * and again only if it failed, took over half a second, or was answered locally.
 */
export function traceHem(hem: any, sink: TraceSink): any {
  return new Proxy(hem, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function') return v
      const describe = typeof prop === 'string' ? CALLS[prop] : undefined
      if (!describe) return v.bind(target)
      return (...args: any[]) => {
        let what: string
        try { what = describe(args) } catch { what = String(prop) }
        sink(`Req ${what}`, 'req')
        const t0 = Date.now()
        const out = v.apply(target, args)
        if (!out || typeof out.then !== 'function') return out
        return out.then(
          (r: any) => {
            const ms = Date.now() - t0
            // Saying which answers never left the machine matters: several lines
            // in a trace of one sign-in looked like device traffic and were the
            // SDK's token cache.
            if (ms < CACHED_MS) sink(`✓ ${what} ‹cached›`, 'cached')
            else if (ms >= SLOW_MS) sink(`… ${what} — ${ms} ms`, 'slow')
            return r
          },
          (e: any) => {
            sink(`✗ ${what} — ${e?.code ?? e?.name ?? 'error'}: ${e?.message ?? e}`, 'error')
            throw e
          },
        )
      }
    },
  })
}
