import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { planIcons } from '../src-tauri/ios/patch.mjs'

/**
 * The 18 names `tauri ios init` writes into AppIcon.appiconset, taken from the
 * real generated project (tauri-cli 2.11.x) on 2026-09-22. They live here so a
 * template change breaks a test on a laptop rather than an iOS build on a Mac
 * — and so the set this patcher depends on is written down where a reader can
 * see it without an Apple toolchain.
 */
const GENERATED = [
  'AppIcon-20x20@1x.png', 'AppIcon-20x20@2x-1.png', 'AppIcon-20x20@2x.png', 'AppIcon-20x20@3x.png',
  'AppIcon-29x29@1x.png', 'AppIcon-29x29@2x-1.png', 'AppIcon-29x29@2x.png', 'AppIcon-29x29@3x.png',
  'AppIcon-40x40@1x.png', 'AppIcon-40x40@2x-1.png', 'AppIcon-40x40@2x.png', 'AppIcon-40x40@3x.png',
  'AppIcon-60x60@2x.png', 'AppIcon-60x60@3x.png',
  'AppIcon-76x76@1x.png', 'AppIcon-76x76@2x.png',
  'AppIcon-83.5x83.5@2x.png',
  'AppIcon-512@2x.png',
  'Contents.json',
]

test('every icon the generated set references is one we actually ship', () => {
  const ours = readdirSync(new URL('../src-tauri/icons/ios', import.meta.url))
  const planned = planIcons(ours, GENERATED)
  // Contents.json is the manifest, not an icon: it names the files and must not
  // be overwritten, so it has no business in the copy list.
  assert.ok(!planned.includes('Contents.json'))
  assert.equal(planned.length, GENERATED.length - 1)
})

test('a template that asks for an icon we do not have stops the build', () => {
  assert.throws(
    () => planIcons(['AppIcon-20x20@1x.png'], ['AppIcon-20x20@1x.png', 'AppIcon-1024x1024@1x.png']),
    /do not have: AppIcon-1024x1024@1x\.png/,
  )
})

test('an icon of ours the template never references stops the build too', () => {
  // The dangerous direction: copying a file into a set nothing reads looks like
  // it worked and leaves the home screen unchanged.
  assert.throws(
    () => planIcons(['AppIcon-20x20@1x.png', 'AppIcon-ancient@1x.png'], ['AppIcon-20x20@1x.png']),
    /does not reference: AppIcon-ancient@1x\.png/,
  )
})

test('an empty side is a broken checkout, not an empty plan', () => {
  assert.throws(() => planIcons([], GENERATED), /icons\/ios holds no \.png/)
  assert.throws(() => planIcons(['AppIcon-20x20@1x.png'], ['Contents.json']), /appiconset holds no \.png/)
})
