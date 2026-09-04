/**
 * passmeter.ts — an ESTIMATE of how a chosen password stands against offline
 * brute force. Local, pure, and it never leaves the function: the password is
 * read, judged, and forgotten.
 *
 * ## Why the app rates passwords at all
 *
 * A software profile is sealed under this password in localStorage
 * (PBKDF2-1M -> AES, `lib/profile.ts`), with no verifier and no recovery.
 * The attack it must survive is not someone guessing at the login card — it
 * is someone who COPIED the blob (a stolen laptop, a synced browser profile,
 * a backup) grinding offline at full speed. A million rounds slow that grind
 * a million-fold and still cannot save `kasia2024`. The moment the password
 * is typed is the only moment anyone can say so.
 *
 * ## Why hand-rolled and not zxcvbn
 *
 * zxcvbn is the standard and it is ~800 KB of dependency for a judgement this
 * app only needs four buckets of. The project's rule stands: one third-party
 * crypto dependency (ML-KEM), everything else ours. This estimator is honest
 * about being an estimate: entropy from length and character classes, cut
 * down for the patterns people actually type — repeats, keyboard runs,
 * sequences, a trailing year, a top-list password dressed up with l33t.
 *
 * ## Enforced since 2026-09-03 — the meter must be full
 *
 * It was advisory until then (the UI warned, the weakest bucket asked once,
 * nothing was refused). The user's decision moved it to a floor: a password
 * BELOW `ENFORCE_MIN` is refused where one is chosen — profile creation and
 * the change-password modal — and the two sites read this constant so they
 * cannot drift apart.
 *
 * The floor is the TOP bucket, not the first green one, for two reasons that
 * only look strict together. The blob is grindable forever with no server to
 * rate-limit it, no rotation and no revocation, so the promise has to be the
 * "never" bucket rather than the "decades on one GPU" one. And reaching it
 * costs a word: `kot pies dom` is 71 bits, `zielonyRower` 64. What the first
 * green bucket would have blessed is `lubieplacki` (52) and `M0jPies!` (53)
 * — the 8-to-11-character shape breach corpora are made of.
 *
 * Two boundaries the floor deliberately stops at. It is never applied at
 * SIGN-IN: refusing to open an identity that already exists would lock
 * someone out of a key nobody can recover, so an old weak profile keeps
 * working and meets the floor the next time its password is chosen. And
 * `mig-pass` (§10 export) has no meter and no floor — it seals under the
 * profile's EXISTING password, so there is nothing there to choose.
 */

/** What to tell the person, as a code — the UI owns the words (i18n). */
export type Advice = 'common' | 'short' | 'one-class' | 'patterns' | 'ok'

export interface Strength {
  /** Estimated bits against an offline guesser. An estimate, not a proof. */
  bits: number
  /** 0 słabe | 1 przeciętne | 2 prawie | 3 mocne (the only accepted one) */
  score: 0 | 1 | 2 | 3
  advice: Advice
}

/** The floor: a password scoring below this is REFUSED where one is chosen
 *  (see the section above). 3 is the full meter — four bars, ~60 bits. */
export const ENFORCE_MIN = 3

/** Bucket edges in estimated bits, calibrated against PBKDF2-1M: at ~18k
 *  guesses/s/GPU, 28 bits falls in hours, 45 bits in decades on one card
 *  (months on a rented rack — which is why the floor is the next bucket up),
 *  60 bits never. */
const EDGE = [28, 45, 60]

/**
 * The passwords people actually use, top of every breach corpus, plus the
 * Polish staples the global lists miss. Lowercase. A few hundred BYTES —
 * this is the whole argument against needing a library.
 */
const COMMON = new Set([
  '123456', '123456789', '12345678', '12345', '1234567', '1234567890', '1234',
  '111111', '123123', '000000', '654321', '666666', '121212', '112233',
  '789456', '159753', '123321', '007007',
  'password', 'password1', 'password123', 'haslo', 'haslo123', 'hasło',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn',
  'zxcvbnm', 'asdf1234', 'qazwsx', 'zaq12wsx', '1qaz2wsx', '1q2w3e4r',
  '1q2w3e', 'q1w2e3r4', 'abc123', 'abcd1234', 'a1b2c3',
  'admin', 'root', 'login', 'welcome', 'letmein', 'secret', 'test', 'guest',
  'master', 'shadow', 'dragon', 'monkey', 'killer', 'hunter', 'buster',
  'trustno1', 'freedom', 'whatever', 'sunshine', 'princess', 'flower',
  'iloveyou', 'lovely', 'hello', 'charlie', 'jordan', 'harley', 'pepper',
  'ginger', 'tigger', 'mustang', 'access', 'batman', 'superman', 'starwars',
  'pokemon', 'football', 'baseball', 'soccer', 'hockey', 'summer', 'winter',
  'orange', 'purple', 'banana', 'cheese', 'chocolate', 'computer', 'internet',
  'samsung', 'google', 'michael', 'andrew', 'matthew', 'daniel', 'thomas',
  'jessica', 'jennifer', 'michelle', 'ashley', 'nicole', 'hannah', 'joshua',
  'maggie', 'george', 'donald', 'system',
  'polska', 'misiek', 'kasia', 'basia', 'aniela', 'michal', 'mateusz',
  'marcin', 'lukasz', 'krzysztof', 'agnieszka', 'monika', 'karolina',
  'bartek', 'madzia', 'kochanie', 'kochana', 'slonce', 'sloneczko', 'motyl',
  'gitara', 'komputer', 'internetowa', 'wiosna', 'zima', 'lato', 'jesien',
  'pilka', 'legia', 'wisla', 'lech',
])

/** Undo the dress-up: `P@ssw0rd` and `password` are the same password. */
const LEET: Record<string, string> = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'l', '!': 'i', '0': 'o', '$': 's',
  '5': 's', '7': 't', '8': 'b',
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

/** Are two lowercased characters neighbours on a keyboard row? */
function rowNeighbours(a: string, b: string): boolean {
  for (const r of ROWS) {
    const i = r.indexOf(a)
    if (i >= 0 && Math.abs(r.indexOf(b) - i) === 1 && r.includes(b)) return true
  }
  return false
}

/**
 * Length that deserves the name: the third and later characters of any run —
 * a repeat (`aaa`), an alphabet/digit sequence up or down (`abcd`, `4321`),
 * or a keyboard walk (`qwer`) — count a quarter each. `abcdefgh` is not
 * eight characters of surprise; it is two and a rule.
 */
function effectiveLength(pw: string): number {
  let eff = 0
  let run = 1
  const low = pw.toLowerCase()
  for (let i = 0; i < low.length; i++) {
    if (i > 0) {
      const d = low.charCodeAt(i) - low.charCodeAt(i - 1)
      const joined = d === 0 || d === 1 || d === -1 || rowNeighbours(low[i - 1], low[i])
      run = joined ? run + 1 : 1
    }
    eff += run > 2 ? 0.25 : 1
  }
  return eff
}

export function assessPassword(pw: string): Strength {
  if (!pw) return { bits: 0, score: 0, advice: 'short' }

  const low = pw.toLowerCase()
  // The list is consulted three ways: verbatim, with the l33t dress-up
  // undone, and with a trailing "make it special" tail (digits/symbols)
  // stripped — `password`, `P@ssw0rd` and `password1!` are one password.
  const unleet = low.replace(/./g, (c) => LEET[c] ?? c)
  const bare = low.replace(/[\d\W_]+$/, '')
  const bareUnleet = unleet.replace(/[\d\W_]+$/, '')
  if (COMMON.has(low) || COMMON.has(unleet)) {
    return { bits: 7, score: 0, advice: 'common' }
  }
  if ((bare && COMMON.has(bare)) || (bareUnleet && COMMON.has(bareUnleet))) {
    // The tail is worth a few bits; the base is worth a lookup.
    return { bits: Math.min(16, 7 + (pw.length - bare.length) * 3), score: 0, advice: 'common' }
  }

  let eff = effectiveLength(pw)
  // A trailing year is a calendar, not four characters: `Krakow2024` ends in
  // one of ~200 plausible values (~ 2 characters of a lowercase pool).
  if (/(19|20)\d\d$/.test(pw) && pw.length > 4) eff = Math.max(1, eff - 2)

  let pool = 0
  if (/[a-z]/.test(pw)) pool += 26
  if (/[A-Z]/.test(pw)) pool += 26
  if (/\d/.test(pw)) pool += 10
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33
  const bits = Math.round(eff * Math.log2(pool || 1))

  const score: Strength['score'] =
    bits < EDGE[0] ? 0 : bits < EDGE[1] ? 1 : bits < EDGE[2] ? 2 : 3
  const oneClass = pool === 26 || pool === 10
  // 'ok' means "nothing to fix", so only the accepted bucket may say it: with
  // a floor at the top bucket, a password that is refused and advised nothing
  // is a form that will not say what it wants. Below it, lengthening is always
  // true, so it is the fallback.
  const advice: Advice =
    score >= ENFORCE_MIN ? 'ok'
      : eff < pw.length * 0.75 ? 'patterns'
        : pw.length < 10 ? 'short'
          : oneClass ? 'one-class' : 'short'
  return { bits, score, advice }
}
