/**
 * saveas.ts — "save this file", asking where when the platform can ask.
 *
 * Every save in the app used to be an anchor with `download`: the browser
 * picks the folder, and Save and Open ended up doing the same thing (the
 * user's remark, 2026-09-14: "save powinno pokazac GDZIE zapisac"). Where the
 * File System Access API exists — Chromium, Edge, and WebView2 in the Windows
 * desktop — `showSaveFilePicker` puts a real "save as" dialog behind the
 * button. Firefox and Safari have no such API; there the anchor stays and
 * the browser's own "always ask where to save" setting is the switch. In the
 * Linux and macOS desktop the webview has no picker either, and the HOST
 * intercepts the download with a native dialog (`on_download` in lib.rs), so
 * the same anchor ends in a dialog there too.
 *
 * Two phases on purpose: `beginSave` OPENS the sink and `write` fills it.
 * The picker wants the click it was born from (transient activation), and a
 * file from the node is fetched and decrypted first — asked afterwards, the
 * picker would refuse and the file would silently land in Downloads. Asked
 * first, the person chooses, then waits.
 *
 * What counts as "no": only an AbortError — the person closed the dialog and
 * that is an answer, so `beginSave` returns null and nothing is written.
 * Anything else the picker throws (no gesture, an insecure context, a name it
 * refuses) is not the person's decision, and falls back to the anchor.
 */

export interface SaveSink {
  readonly kind: 'picker' | 'download'
  /** Put the bytes where the sink points. Rejects if the platform could not. */
  write(blob: Blob): Promise<void>
  /**
   * Take back what `beginSave` created, when there is nothing to write after
   * all: the picker creates an empty file the moment a name is chosen, and a
   * fetch that fails afterwards must not leave a zero-byte file behind. Best
   * effort — the anchor has nothing to discard, and not every engine can.
   */
  discard(): Promise<void>
}

/** The picker's handle, as much of it as this module touches. */
interface PickedHandle {
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>
  remove?(): Promise<void>
}

export interface SaveEnv {
  /** `window.showSaveFilePicker`, where the platform has it. */
  picker?: (opts: { suggestedName: string }) => Promise<PickedHandle>
  /** The classic route: an anchor with `download`; the browser picks the folder. */
  download: (blob: Blob, name: string) => void
}

export async function beginSave(name: string, env: SaveEnv): Promise<SaveSink | null> {
  if (env.picker) {
    let handle: PickedHandle | null = null
    try { handle = await env.picker({ suggestedName: name }) }
    catch (e: any) {
      if (e?.name === 'AbortError') return null
      handle = null
    }
    if (handle) {
      const h = handle
      return {
        kind: 'picker',
        async write(blob) { const w = await h.createWritable(); await w.write(blob); await w.close() },
        async discard() { try { await h.remove?.() } catch {} },
      }
    }
  }
  return {
    kind: 'download',
    async write(blob) { env.download(blob, name) },
    async discard() {},
  }
}

/** The browser's own two routes. Read at call time, so a test can replace either. */
export function browserSaveEnv(): SaveEnv {
  const w = globalThis as any
  const picker = typeof w.showSaveFilePicker === 'function' ? (o: { suggestedName: string }) => w.showSaveFilePicker(o) : undefined
  return {
    picker,
    download: (blob, name) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; a.click()
      // Long enough for the browser to start the download from the URL; a
      // revoked URL mid-click is an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    },
  }
}
