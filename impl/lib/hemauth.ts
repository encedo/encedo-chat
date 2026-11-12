/**
 * hemauth.ts - where a HEM access token comes from: the password, or the phone.
 *
 * Every device call in the engine first takes a scoped token. With a password
 * that is free after sign-in: the SDK keeps the key it derived from the
 * password and signs any new scope with it, so `authorizePassword(null, scope)`
 * never asks the person again. With the mobile authenticator there is no such
 * key - every scope the token does not already hold is a push to the phone and
 * a person tapping "allow". So the question "may this ask the phone?" has to be
 * answered by the caller, and that is what this module makes explicit.
 *
 *   - **Session scopes** are taken in ONE push at sign-in (the contact search
 *     and the identity's own ECDH - everything a signed-in session does on its
 *     own, in the background). A background call never pushes: when the token
 *     is gone it fails with `hem_reauth` and the app shows the expiry bar.
 *   - **Action scopes** (import, delete, update, generate, a group key) are
 *     asked when the person does the thing that needs them - adding a contact,
 *     an admin changing a group - with a note the phone shows. The caller says
 *     why (`Why`); a call without a reason is a background call.
 *
 * The phone decides how long its token lives (FW 1.3: ext/request takes no
 * exp), and it may grant less than was asked; both are read from the token.
 * This keeps its OWN token list for the phone: each push carries a fresh `ctx`,
 * so the SDK's cache (keyed by ctx) never answers a renewal with the token it
 * is meant to replace.
 *
 * Without a HemAuth attached (the CLI, the tests, a password session) `token`
 * is exactly the old `authorizePassword(null, scope)`.
 */

/** Why a scope is wanted. Absent = a background call, which never pushes. */
export type WhyKind =
  | 'login' | 'read-keys' | 'renew' | 'register'
  | 'contact-add' | 'contact-del' | 'contact-rename' | 'self-rename'
  | 'group-create' | 'group-admin' | 'group-join'
export interface Why { kind: WhyKind; detail?: string }

/** Scopes a session holds for its whole life and renews: everything else is per action. */
const SESSION_KINDS = new Set<WhyKind>(['login', 'read-keys', 'renew'])

/** What the app shows while the phone is asked. */
export interface AskPrompt {
  why: Why
  scope: string[]
  /** ms epoch: the push is withdrawn after this. */
  deadline: number
  cancel(): void
}

export interface HemAuthOpts {
  /** 'password': the SDK's cached key signs every scope (today's behaviour). */
  mode: 'password' | 'remote'
  /** The phone is being asked; the UI shows a modal / the waiting card. */
  onAsk?: (p: AskPrompt) => void
  /** Every ask has finished (granted, refused, cancelled or timed out). */
  onSettle?: () => void
  /** A background call found no token: the session needs the phone again. */
  onReauth?: () => void
  /** A push ended without the token (`denied`, `timeout`, `aborted`, `hem_scope_refused`, ...). */
  onFail?: (e: any, why: Why) => void
  /** The note the phone shows (1..128 chars). */
  note?: (why: Why) => string
  pollTimeout?: number
  now?: () => number
}

interface Held { jwt: string; scopes: string[]; iat: number; exp: number }

export class HemReauthNeeded extends Error {
  readonly code = 'hem_reauth'
  constructor(scope: string[]) { super(`HEM session has no token for ${scope.join(' + ')}`); this.name = 'HemReauthNeeded' }
}
export class HemScopeRefused extends Error {
  readonly code = 'hem_scope_refused'
  constructor(missing: string[]) { super(`the phone did not grant ${missing.join(' + ')}`); this.name = 'HemScopeRefused' }
}

const AUTH = Symbol.for('onchato.hemauth')
const MARGIN_S = 5 // a token this close to its end is not handed out

export const scopeList = (s: string | string[]): string[] => (Array.isArray(s) ? s : [s])

/** The claims of a JWT, unverified (the device verifies it; we only read exp/scope). */
export function jwtClaims(jwt: string): any {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + '='.repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0))))
  } catch { return null }
}

const defaultNote = (w: Why) => `onchato: ${w.kind}${w.detail ? ' ' + w.detail : ''}`

export class HemAuth {
  readonly mode: 'password' | 'remote'
  #hem: any
  #o: HemAuthOpts
  #held: Held[] = []
  #inflight = new Map<string, Promise<string>>()
  #asking = 0
  #ctxSeq = 0
  /** The scopes taken at sign-in and on renewals - what `renew` asks for again. */
  #session = new Set<string>()
  #window: { iat: number; exp: number } | null = null

  constructor(hem: any, o: HemAuthOpts) {
    this.#hem = hem
    this.#o = o
    this.mode = o.mode
    hem[AUTH] = this
  }

  #now() { return Math.floor((this.#o.now ?? Date.now)() / 1000) }

  /** Whether a live token already covers every value of `scope`. */
  has(scope: string | string[]): boolean { return this.#find(scopeList(scope)) !== null }

  #find(want: string[]): Held | null {
    const now = this.#now()
    this.#held = this.#held.filter((h) => h.exp > now)
    return this.#held.find((h) => h.exp > now + MARGIN_S && want.every((s) => h.scopes.includes(s))) ?? null
  }

  /** iat/exp of the session token (the one the expiry bar is about), or null. */
  sessionWindow(): { iat: number; exp: number } | null { return this.#window }

  /** Session scopes held now - what a renewal asks for. */
  sessionScopes(): string[] { return [...this.#session] }

  /**
   * A token for `scope`. Password mode: the SDK's cached key, never a prompt.
   * Phone mode: a held token, else a push - but only when the caller says why.
   */
  async authorize(scope: string | string[], why?: Why): Promise<string> {
    if (this.mode === 'password') return this.#hem.authorizePassword(null, scope)
    const want = scopeList(scope)
    const held = this.#find(want)
    if (held) return held.jwt
    if (!why) { this.#o.onReauth?.(); throw new HemReauthNeeded(want) }
    const key = [...want].sort().join(' ')
    let p = this.#inflight.get(key)
    if (!p) {
      p = this.#push(want, why).finally(() => this.#inflight.delete(key))
      this.#inflight.set(key, p)
    }
    return p
  }

  /** Ask the phone for the session scopes again, before the token runs out. */
  renew(): Promise<string> {
    const scopes = this.sessionScopes()
    if (!scopes.length) return Promise.reject(new HemReauthNeeded([]))
    return this.#push(scopes, { kind: 'renew' })
  }

  async #push(want: string[], why: Why): Promise<string> {
    const pollTimeout = this.#o.pollTimeout ?? 60_000
    const ac = new AbortController()
    this.#asking++
    try {
      this.#o.onAsk?.({ why, scope: want, deadline: Date.now() + pollTimeout, cancel: () => ac.abort() })
      const note = (this.#o.note ?? defaultNote)(why).slice(0, 128)
      // A fresh ctx per push: the SDK caches by ctx, and a renewal must reach the phone.
      const ctx = `onchato-${(++this.#ctxSeq).toString(36)}-${Date.now().toString(36)}`
      const jwt: string = await this.#hem.authorizeRemote(want.length === 1 ? want[0] : want, {
        ctx, note, pollTimeout, signal: ac.signal,
      })
      const c = jwtClaims(jwt) ?? {}
      const granted = scopeList(c.scope ?? want)
      const now = this.#now()
      const held: Held = { jwt, scopes: granted, iat: Number(c.iat) || now, exp: Number(c.exp) || now + 300 }
      this.#held.push(held)
      const missing = want.filter((s) => !granted.includes(s))
      if (SESSION_KINDS.has(why.kind)) {
        for (const s of granted) this.#session.add(s)
        // The bar follows the newest session token; a renewal replaces the window.
        this.#window = { iat: held.iat, exp: held.exp }
      }
      if (missing.length) throw new HemScopeRefused(missing)
      return jwt
    } catch (e) {
      this.#o.onFail?.(e, why)
      throw e
    } finally {
      if (--this.#asking === 0) this.#o.onSettle?.()
    }
  }

  /** Forget every token (sign-out). */
  clear() { this.#held = []; this.#session.clear(); this.#window = null }
}

/** The HemAuth attached to this HEM, if any. */
export const authOf = (hem: any): HemAuth | undefined => hem?.[AUTH]

/**
 * The one way the engine takes a token. `why` absent = background (never a
 * push); present = the person is doing something that needs this scope.
 */
export function token(hem: any, scope: string | string[], why?: Why): Promise<string> {
  const a = authOf(hem)
  return a ? a.authorize(scope, why) : hem.authorizePassword(null, scope)
}

/** Whether a token for `scope` is held without asking anybody (phone mode).
 *  A password session always can: the key signs any scope. */
export function canSilently(hem: any, scope: string | string[]): boolean {
  const a = authOf(hem)
  return !a || a.mode === 'password' || a.has(scope)
}

/**
 * Which step of the expiry bar a session is at: 0 none, 1..4 at 80/85/90/95%
 * of the token's life, 5 expired. The bar shows when the step goes up, so
 * closing it at 80% brings it back at 85%.
 */
export function renewStep(win: { iat: number; exp: number } | null, nowS: number): number {
  if (!win || win.exp <= win.iat) return 0
  if (nowS >= win.exp) return 5
  const f = (nowS - win.iat) / (win.exp - win.iat)
  return f >= 0.95 ? 4 : f >= 0.9 ? 3 : f >= 0.85 ? 2 : f >= 0.8 ? 1 : 0
}
