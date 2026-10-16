#!/usr/bin/env node
/**
 * web-monitor.mjs - is the web app the host serves the one that was approved?
 *
 *   node scripts/web-monitor.mjs                       # app.onchato.com against onchato.com/release
 *
 * Three states (exit 0 unless said otherwise):
 *   OK        the served index.html is the CID the signed manifest names.
 *   PENDING   it is the CID CI built for the latest release tag, not signed yet
 *             - the window between a tag and `approve-web.mjs`. Exit 1 once
 *             every 8 hours of waiting (the 8th, 16th, ... hour), so the
 *             reminder is a mail every 8 h, not every hour.
 *   ALARM     it is neither: the host serves code nobody built from a tag or
 *             approved. Exit 1 on every run.
 *
 * What it cannot see: a host that serves the right file to everyone else and
 * another one to a chosen person. That only a client-side check can catch
 * (THREAT-MODELS.md B3).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cidV1Raw } from '../impl/lib/cid.ts'
import { verifyManifest } from '../impl/lib/manifest.ts'
import { findCiBuild } from './ci-cid.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = process.env.MONITOR_WEB ?? 'https://app.onchato.com/'
const MANIFEST = process.env.MONITOR_MANIFEST ?? 'https://onchato.com/release/manifest.json'
const REPO = process.env.GITHUB_REPOSITORY ?? 'encedo/encedo-chat'
const REMIND_H = 8
const rootPub = readFileSync(join(ROOT, 'infra', 'root.pub'), 'utf8').trim()
const now = Date.now()

const get = async (u, init = {}) => {
  const r = await fetch(u, { cache: 'no-store', ...init })
  if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`)
  return r
}
const say = (state, msg, code) => { console.log(`${state}: ${msg}`); process.exit(code) }

const served = await cidV1Raw(new Uint8Array(await (await get(WEB)).arrayBuffer()))
console.log(`served   ${served}  (${WEB})`)

const raw = new Uint8Array(await (await get(MANIFEST)).arrayBuffer())
const sig = (await (await get(MANIFEST.replace(/\.json$/, '.sig'))).text()).trim()
const v = verifyManifest(raw, sig, rootPub, now)
// An expired manifest still says what was approved; a bad signature says nothing.
const m = v.ok ? v.manifest : (v.why === 'expired' ? JSON.parse(new TextDecoder().decode(raw)) : null)
if (!m) say('ALARM', `the manifest at ${MANIFEST} does not verify under infra/root.pub (${v.why})`, 1)
console.log(`signed   ${m.web?.cid ?? '(no web entry)'}  (manifest v${m.version}${v.ok ? '' : ', EXPIRED'})`)
if (m.web?.cid === served) say('OK', `the served web app is the approved one (v${m.version})`, 0)

// Not the approved one. Is it what CI built for the latest release tag?
const gh = { headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } }
// A draft release is invisible to this read-only token, so ci-cid.mjs also
// reads the run's `web-cid-<tag>-<cid>` artifact (needs `actions: read`).
const build = await findCiBuild(served, {
  repo: REPO,
  getJson: async (u) => (await get(u, gh)).json(),
  getText: async (u) => (await get(u, { headers: { ...gh.headers, accept: 'application/octet-stream' } })).text(),
  log: (m) => console.log(m),
})
const tag = build?.tag, since = build?.since
if (build) console.log(`ci       ${served}  (${tag}, from the ${build.via})`)
if (!build) say('ALARM', `the host serves ${served}, which is neither the approved CID nor one CI built for a recent release tag`, 1)
const waited = (now - since) / 3_600_000
const hour = Math.floor(waited)
const remind = hour >= REMIND_H && hour % REMIND_H === 0
say('PENDING', `the host serves ${tag} (${served}), built by CI ${hour} h ago, not yet approved - run scripts/approve-web.mjs ${tag}`
  + (remind ? ` [reminder: ${hour} h waiting]` : ''), remind ? 1 : 0)
