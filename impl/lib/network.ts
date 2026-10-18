/**
 * network.ts - the network profile: every address a client needs that is not
 * a relay node.
 *
 * Until 0.7.44 these lived as constants scattered through the app and the
 * terminal client (SITE_ORIGIN, CANONICAL_ORIGIN, the manifest URL, the
 * feedback sink, the CLI's APP_ORIGIN and default store). A build for another
 * network changed `EC_NETWORK` and the node list and still sent its file
 * ciphertext to onchato.com and asked onchato.com for its release manifest.
 * The profile puts them in one file (`infra/network.json`), read the same way
 * by both front-ends, so that a network is one file and not five edits.
 *
 * What the profile is NOT (yet): signed, or refreshable. It is a build input,
 * like `infra/nodes.json`; the operator's signature and the refresh come with
 * the network manifest, a later step.
 *
 * The relay nodes stay in `infra/nodes.json` for now - they already have their
 * own format, refresh path and CID check.
 */

export interface AppAddress {
  /** A bare origin, `https://host[:port]`, no path. */
  origin: string
  /** The path the app lives at on that origin, starting with `/`. */
  path: string
}

export interface NetworkProfile {
  v: 1
  /** Mixed into every topic derivation (SPEC §5); `EC_NETWORK` / `--network` may override it for development. */
  networkId: string
  /** Who runs this network, as people should see it. */
  operator: string
  /** Where invite links point when the client has no address bar of its own (packaged apps, the CLI). */
  app: AppAddress
  /** Older addresses of the app whose invite links are still ours. */
  legacyApp: AppAddress[]
  /** File store origins, tried in order: an upload goes to the first that takes it, a download asks each (net/ipfs.ts). */
  stores: string[]
  /** Where the signed release manifest is served; its `.sig` sits beside it. */
  manifestUrls: string[]
  /** Where the feedback form posts. */
  feedback: string
  /** The operator's home page, linked from the sign-in screen. */
  home: string
}

const MAX_LIST = 8

const fail = (why: string): never => { throw new Error(`network profile: ${why}`) }

/** True for the loopback hosts a developer runs a store or an app on. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/** An https URL (http only on loopback); returns it parsed. */
function url(v: unknown, what: string): URL {
  if (typeof v !== 'string' || !v) return fail(`${what} is missing`)
  let u: URL
  try { u = new URL(v) } catch { return fail(`${what} is not a URL: ${v}`) }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    return fail(`${what} must be https: ${v}`)
  }
  if (u.username || u.password) return fail(`${what} carries credentials`)
  if (u.hash || u.search) return fail(`${what} carries a query or fragment: ${v}`)
  return u
}

/** A bare origin: the URL must be exactly its own origin (a trailing slash is tolerated). */
function origin(v: unknown, what: string): string {
  const u = url(v, what)
  if (u.pathname !== '/' || (typeof v === 'string' && v.replace(/\/$/, '') !== u.origin)) {
    return fail(`${what} must be a bare origin, without a path: ${v}`)
  }
  return u.origin
}

function appAddress(v: unknown, what: string): AppAddress {
  if (!v || typeof v !== 'object') return fail(`${what} is missing`)
  const o = v as Record<string, unknown>
  const path = o.path
  if (typeof path !== 'string' || !path.startsWith('/')) return fail(`${what}.path must start with /`)
  return { origin: origin(o.origin, `${what}.origin`), path }
}

function list<T>(v: unknown, what: string, each: (x: unknown, w: string) => T, allowEmpty = false): T[] {
  if (!Array.isArray(v)) return fail(`${what} must be a list`)
  if (!allowEmpty && v.length === 0) return fail(`${what} is empty`)
  if (v.length > MAX_LIST) return fail(`${what} has more than ${MAX_LIST} entries`)
  return v.map((x, i) => each(x, `${what}[${i}]`))
}

/**
 * Validate a profile and return it normalised (origins without a trailing
 * slash). Throws with the reason on anything it does not understand: a client
 * pointed at half a network is worse than one that refuses to start.
 */
export function parseNetworkProfile(raw: unknown): NetworkProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not an object')
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return fail(`unknown version ${String(o.v)}`)
  const networkId = o.networkId
  if (typeof networkId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(networkId)) {
    return fail('networkId must be 1-64 characters of letters, digits, dot, dash or underscore')
  }
  const operator = o.operator
  if (typeof operator !== 'string' || !operator.trim() || operator.length > 100) return fail('operator must be a name of 1-100 characters')
  return {
    v: 1,
    networkId,
    operator: operator.trim(),
    app: appAddress(o.app, 'app'),
    legacyApp: list(o.legacyApp ?? [], 'legacyApp', appAddress, true),
    stores: list(o.stores, 'stores', origin),
    manifestUrls: list(o.manifestUrls, 'manifestUrls', (x, w) => {
      const u = url(x, w)
      if (!u.pathname.endsWith('.json')) fail(`${w} must name a .json file (its .sig sits beside it)`)
      return u.href
    }),
    feedback: url(o.feedback, 'feedback').href,
    home: url(o.home, 'home').href,
  }
}

/** The `.sig` that sits beside a manifest URL. */
export function sigUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\.json$/, '.sig')
}
