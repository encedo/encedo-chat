/**
 * capabilities.ts — what this engine needs from the platform, checked before it
 * is needed.
 *
 * This exists because of WebKitGTK. The Tauri desktop build runs on a webview
 * that HAS X25519 but has no WebRTC, and finding that out took a debugging
 * session rather than a line of output. Every webview is a different subset:
 * Android's is Chromium updated through the Play Store (so its age tracks the
 * store, not the OS version), iOS is WKWebView and therefore whatever WebKit
 * the OS shipped, desktop Linux is WebKitGTK. Guessing from version numbers is
 * how you get a client that hangs mid-handshake with nothing in any log.
 *
 * The distinction that matters is REQUIRED versus DEGRADED. X25519 is required:
 * without it there is no rendezvous, no EH-2, no ratchet, and the honest
 * response is to refuse to start with a clear reason. WebRTC is not: content
 * falls back to GossipSub through the relay, which is exactly what the desktop
 * build already does, so its absence is a note and not an error.
 */

/**
 * A required probe that fails is retried before the platform is declared unfit.
 * Three attempts 150 ms apart costs under half a second on a machine that has a
 * genuine problem, and rescues one that only needed a moment.
 */
const REQUIRED_TRIES = 3
const RETRY_MS = 150

export interface Capability {
  id: string
  /** Missing this means the app cannot work at all. */
  required: boolean
  ok: boolean
  /**
   * What the platform actually threw, when it threw. Kept because a swallowed
   * exception made a real report unanswerable: X25519 failed once on WebKitGTK,
   * worked after a restart, and `catch {}` meant nobody could say whether it was
   * NotSupportedError, OperationError or something else entirely.
   */
  error?: string
  /** How many attempts this took. >1 means the platform needed a moment. */
  tries?: number
  /** What the user loses. Empty when it is fine. */
  note?: string
}

export interface CapabilityReport {
  ok: boolean            // every REQUIRED capability present
  caps: Capability[]
  missing: Capability[]  // required and absent
  degraded: Capability[] // optional and absent
  ua: string
}

/**
 * Probe the platform. Async because the only honest X25519 test is to actually
 * derive with it — several webviews expose the algorithm name and then throw on
 * use, which a feature-detect by string would report as present.
 */
export async function probeCapabilities(): Promise<CapabilityReport> {
  const caps: Capability[] = []
  const add = (id: string, required: boolean, ok: boolean, note?: string, error?: string, tries?: number) =>
    caps.push({ id, required, ok, note: ok ? undefined : note, error, tries: tries && tries > 1 ? tries : undefined })

  /**
   * Try a probe more than once before calling the platform unfit.
   *
   * A capability that fails and then succeeds on a restart was never absent —
   * WebKitGTK brings its crypto backend up lazily, and the first call in a fresh
   * process can lose that race. One attempt turned that into a permanent refusal
   * with no way back except restarting the app.
   *
   * Only the REQUIRED probes retry: a missing optional is a note, and spending
   * half a second confirming it would delay every start for nothing.
   */
  const attempt = async (fn: () => Promise<boolean>, tries = REQUIRED_TRIES): Promise<{ ok: boolean; error?: string; tries: number }> => {
    let error: string | undefined
    for (let n = 1; n <= tries; n++) {
      try {
        if (await fn()) return { ok: true, error: undefined, tries: n }
        error = 'returned false' // no exception, but the answer was wrong — say so
      } catch (e: any) { error = `${e?.name ?? 'Error'}: ${e?.message ?? e}` }
      if (n < tries) await new Promise((r) => setTimeout(r, RETRY_MS))
    }
    return { ok: false, error, tries }
  }

  const subtle = globalThis.crypto?.subtle

  add('crypto.subtle', true, !!subtle,
    'Brak WebCrypto — najczęściej strona serwowana po HTTP zamiast HTTPS (secure context).')

  // The one that decides everything. Generate, export and derive — a webview
  // that merely knows the name is not one that can do the handshake.
  // The steps are exactly what `generateX25519()` does at runtime — a probe that
  // tested less than the app uses would pass and then fail where it matters.
  const x = await attempt(async () => {
    const kp = (await subtle!.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    const pub = await subtle!.exportKey('raw', kp.publicKey)
    const peer = await subtle!.importKey('raw', pub, { name: 'X25519' }, false, [])
    const bits = await subtle!.deriveBits({ name: 'X25519', public: peer }, kp.privateKey, 256)
    return new Uint8Array(bits).length === 32
  }, subtle ? REQUIRED_TRIES : 0)
  add('X25519', true, x.ok,
    'Ta przeglądarka nie umie X25519 w WebCrypto — bez tego nie da się ustalić pokoju ani uzgodnić szyfrowania. Zaktualizuj przeglądarkę (na Androidzie: System WebView w sklepie Play).',
    x.error, x.tries)

  const h = await attempt(async () => {
    const k = await subtle!.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits'])
    return (await subtle!.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) }, k, 256)).byteLength === 32
  }, subtle ? REQUIRED_TRIES : 0)
  add('HKDF', true, h.ok, 'Brak HKDF-SHA256 w WebCrypto.', h.error, h.tries)

  const a = await attempt(async () => {
    const k = await subtle!.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const ct = await subtle!.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k as CryptoKey, new Uint8Array(4))
    return ct.byteLength > 4
  }, subtle ? REQUIRED_TRIES : 0)
  add('AES-GCM', true, a.ok, 'Brak AES-GCM w WebCrypto.', a.error, a.tries)

  add('WebSocket', true, typeof WebSocket === 'function',
    'Brak WebSocket — nie da się połączyć z węzłem sieci.')

  add('localStorage', true, (() => {
    try { const k = '__ec_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true } catch { return false }
  })(), 'Brak localStorage — tożsamość i kontakty nie przetrwają odświeżenia. Tryb prywatny?')

  // Optional from here down: the app runs without these, with less.
  add('WebRTC', false, typeof RTCPeerConnection === 'function',
    'Brak WebRTC — treść pójdzie przez węzeł sieci (relay), nie bezpośrednio. Tak działa też build desktopowy.')

  add('visualViewport', false, typeof (globalThis as any).visualViewport === 'object',
    'Brak visualViewport — na telefonie klawiatura może zasłonić pole wpisywania.')

  // Optional, and worth probing rather than assuming: several webviews expose no
  // Notification at all (and a packaged app may route them through the host
  // instead). Without it the setting is hidden — an option that cannot do
  // anything is worse than a missing one.
  add('Notification', false, typeof (globalThis as any).Notification === 'function',
    'Brak powiadomień systemowych — o nowej wiadomości dowiesz się dopiero po wróceniu do aplikacji.')

  // Recording needs both halves too, and WebKitGTK is exactly the platform
  // where they can come apart. Without it the microphone button is hidden — the
  // same rule as the QR scanner: an option that cannot do anything is worse
  // than a missing one.
  add('MediaRecorder', false,
    typeof (globalThis as any).MediaRecorder === 'function'
    && typeof navigator === 'object' && !!navigator.mediaDevices?.getUserMedia,
    'Ta platforma nie umie nagrywać dźwięku — głosówek nie da się nagrać, ale przysłane można odsłuchać.')

  // Reading a QR needs both halves, and they fail apart: Shape Detection is
  // absent on desktop Linux/Windows Chrome (it ships on Android, macOS and
  // ChromeOS), while a camera may be missing anywhere. Showing a code always
  // works — it is scanning that is conditional, and the app says so instead of
  // opening a viewfinder that can never resolve anything.
  add('BarcodeDetector', false,
    typeof (globalThis as any).BarcodeDetector === 'function'
    && typeof navigator === 'object' && !!(navigator as any).mediaDevices?.getUserMedia,
    'Ta platforma nie umie czytać kodów QR (brak czytnika albo dostępu do kamery) — kod można pokazać, ale nie zeskanować; zostaje wklejenie linku.')

  const missing = caps.filter((c) => c.required && !c.ok)
  const degraded = caps.filter((c) => !c.required && !c.ok)
  return {
    ok: missing.length === 0,
    caps, missing, degraded,
    ua: typeof navigator === 'object' ? navigator.userAgent : '(brak navigator)',
  }
}

/** One line per capability — for the debug log and for a bug report. */
export function formatReport(r: CapabilityReport): string {
  const line = (c: Capability) =>
    `${c.ok ? '✓' : c.required ? '✖' : '·'} ${c.id}`
    + (c.tries ? ` (took ${c.tries} attempts)` : '')
    + (c.ok ? '' : ` — ${c.note ?? ''}${c.error ? ` [${c.error}]` : ''}`)
  return [`platform: ${r.ua}`, ...r.caps.map(line)].join('\n')
}
