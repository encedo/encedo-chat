/** fp.ts - a key's fingerprint, the app's form: SHA-256(pub)[0:8] as colon hex,
 *  "29:7A:7B:B3:35:8F:CD:2A". The ignore list is keyed by it, so it must match
 *  the app byte for byte. */
export async function fingerprint(pubB64: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0)))).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}
