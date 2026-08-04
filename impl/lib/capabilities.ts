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

export interface Capability {
  id: string
  /** Missing this means the app cannot work at all. */
  required: boolean
  ok: boolean
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
  const add = (id: string, required: boolean, ok: boolean, note?: string) =>
    caps.push({ id, required, ok, note: ok ? undefined : note })

  const subtle = globalThis.crypto?.subtle

  add('crypto.subtle', true, !!subtle,
    'Brak WebCrypto — najczęściej strona serwowana po HTTP zamiast HTTPS (secure context).')

  // The one that decides everything. Generate, export and derive — a webview
  // that merely knows the name is not one that can do the handshake.
  let x25519 = false
  if (subtle) {
    try {
      const kp = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
      const pub = await subtle.exportKey('raw', kp.publicKey)
      const peer = await subtle.importKey('raw', pub, { name: 'X25519' }, false, [])
      const bits = await subtle.deriveBits({ name: 'X25519', public: peer }, kp.privateKey, 256)
      x25519 = new Uint8Array(bits).length === 32
    } catch { x25519 = false }
  }
  add('X25519', true, x25519,
    'Ta przeglądarka nie umie X25519 w WebCrypto — bez tego nie da się ustalić pokoju ani uzgodnić szyfrowania. Zaktualizuj przeglądarkę (na Androidzie: System WebView w sklepie Play).')

  let hkdf = false
  if (subtle) {
    try {
      const k = await subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits'])
      hkdf = (await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) }, k, 256)).byteLength === 32
    } catch { hkdf = false }
  }
  add('HKDF', true, hkdf, 'Brak HKDF-SHA256 w WebCrypto.')

  let aead = false
  if (subtle) {
    try {
      const k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k as CryptoKey, new Uint8Array(4))
      aead = ct.byteLength > 4
    } catch { aead = false }
  }
  add('AES-GCM', true, aead, 'Brak AES-GCM w WebCrypto.')

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
  const line = (c: Capability) => `${c.ok ? '✓' : c.required ? '✖' : '·'} ${c.id}${c.ok ? '' : ` — ${c.note ?? ''}`}`
  return [`platform: ${r.ua}`, ...r.caps.map(line)].join('\n')
}
