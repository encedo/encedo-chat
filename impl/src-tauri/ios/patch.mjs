/**
 * patch.mjs — put OUR mark on the generated iOS project.
 *
 * `tauri ios init` writes the whole Xcode project from a template, into a
 * gitignored directory, the same way `android init` does. So anything we need
 * in that project has to be applied AFTER init, and this is the iOS half of
 * `src-tauri/android/patch.mjs`.
 *
 * It does ONE thing, and the list of things it does not do matters as much:
 *
 *   ICONS. `ios init` writes the template's own AppIcon set and ignores
 *   `src-tauri/icons/ios` entirely, so the app wears **Tauri's logo** on the
 *   home screen. This is not a guess: the generated
 *   `Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` was Tauri's yellow
 *   and cyan mark, while our own 18 files sat unused in the repository under
 *   exactly the same 18 names. Android shipped this bug for real in 0.4.5
 *   ("the app on the home screen wears Tauri's logo") and was fixed the same
 *   way. Nothing fails, nothing is logged, and the only place it shows is a
 *   home screen — which is why it needs a check that throws.
 *
 *   NOT the Info.plist. Tauri merges `src-tauri/Info.plist` and
 *   `src-tauri/Info.ios.plist` into the bundle itself, at BUILD time (not at
 *   init — an `init` alone leaves a bare plist, which is what makes this look
 *   broken if you check too early). Measured on 2026-09-22: a key put in
 *   `Info.ios.plist` came out in `gen/apple/onchato_iOS/Info.plist` after
 *   `tauri ios build`. So the camera and microphone descriptions are declared
 *   in those tracked files, where they can be read and reviewed, and this
 *   script must not grow a second, competing copy of them.
 *
 *   NOT a background service. Android needs one because a messenger with no
 *   store-and-forward must hold its own connection; iOS does not offer that
 *   bargain at all, so there is nothing to install here.
 *
 * Like its Android sibling, everything here asserts and throws. A silent no-op
 * would produce an app that installs, runs, and quietly carries somebody
 * else's brand.
 *
 * The planning step is exported so `test/ios-patch.test.ts` can run it without
 * an Apple toolchain.
 */

import { readdirSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Work out which icon files to copy over which, and refuse anything surprising.
 *
 * Both sides are compared by NAME, because that is what `Contents.json` refers
 * to: the generated set's manifest names each slot's file, so replacing the
 * bytes under an existing name is enough and the manifest never has to be
 * touched. Measured before relying on it — our `icons/ios` and the generated
 * appiconset held the same 18 names, no more and no fewer.
 *
 * An extra file on our side is therefore not a bonus but a sign the two have
 * drifted: it would be copied into a set that nothing references, which looks
 * like it worked and changes nothing on the home screen. Both directions throw.
 */
export function planIcons(ours, generated) {
  const png = (names) => names.filter((n) => n.endsWith('.png')).sort()
  const mine = png(ours)
  const theirs = png(generated)

  if (!mine.length) throw new Error('ios icons: src-tauri/icons/ios holds no .png — has `tauri icon` been run?')
  if (!theirs.length) throw new Error('ios icons: the generated AppIcon.appiconset holds no .png — has the template changed?')

  const missing = theirs.filter((n) => !mine.includes(n))
  if (missing.length)
    throw new Error(`ios icons: the generated set wants ${missing.length} file(s) we do not have: ${missing.join(', ')}`)

  const spare = mine.filter((n) => !theirs.includes(n))
  if (spare.length)
    throw new Error(`ios icons: we carry ${spare.length} file(s) the generated set does not reference: ${spare.join(', ')}`
      + ' — icons/ios and the Tauri template have drifted apart')

  return theirs
}

// ---- file side -------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('patch.mjs')) {
  const gen = process.argv[2]
  if (!gen) { console.error('usage: node patch.mjs <path to src-tauri/gen/apple>'); process.exit(2) }
  const here = dirname(fileURLToPath(import.meta.url))

  const from = join(here, '..', 'icons', 'ios')
  const to = join(gen, 'Assets.xcassets', 'AppIcon.appiconset')
  if (!existsSync(from)) throw new Error(`ios icons: ${from} is not there`)
  if (!existsSync(to)) throw new Error(`ios icons: ${to} is not there — did \`ios init\` run?`)

  const names = planIcons(readdirSync(from), readdirSync(to))
  for (const name of names) {
    copyFileSync(join(from, name), join(to, name))
    if (!statSync(join(to, name)).size) throw new Error(`ios icons: ${name} landed empty`)
  }

  console.log(`ios: ${names.length} icon file(s) installed over the template's`)
}
