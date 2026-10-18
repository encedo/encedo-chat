#!/usr/bin/env node
/**
 * check-network-neutral.mjs - a build for another network must not point at
 * the public network's hosts.
 *
 * Builds the web app (the same bundle the desktop and mobile shells load) with
 * a network profile and a node list of a made-up network
 * (impl/test/fixtures/network-other.json, nodes-other.json) into a throwaway
 * directory, then looks for the public network's domain in what the app runs:
 * index.html and every script. Any hit is a constant that escaped the profile
 * (lib/network.ts) - the kind that sent a self-hosted network's file
 * ciphertext to onchato.com until the profile existed.
 *
 * The marketing pages that also land in dist/ (landing, how, privacy, terms)
 * are onchato.com's own site and are not looked at.
 *
 *   node scripts/check-network-neutral.mjs            # exit 0 clean, 1 with every hit listed
 *   node scripts/check-network-neutral.mjs --keep     # leave the build in place for a look
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const IMPL = join(ROOT, 'impl')
const NEEDLE = /onchato\.com/gi

const out = mkdtempSync(join(process.env.EC_CHECK_TMP ?? tmpdir(), 'ec-neutral-'))
try {
  execFileSync('npx', ['webpack', '--config', 'web/webpack.config.cjs', '--mode', 'production'], {
    cwd: IMPL,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      EC_NETWORK_PROFILE: join(IMPL, 'test/fixtures/network-other.json'),
      EC_NODES: join(IMPL, 'test/fixtures/nodes-other.json'),
      EC_OUT: out,
    },
  })
  const files = readdirSync(out).filter((f) => f === 'index.html' || f.endsWith('.js'))
  if (!files.some((f) => f.endsWith('.js'))) throw new Error(`no script in ${out} - did the build run?`)
  const hits = []
  for (const f of files) {
    const text = readFileSync(join(out, f), 'utf8')
    for (const m of text.matchAll(NEEDLE)) {
      const at = m.index ?? 0
      hits.push(`${f}: ...${text.slice(Math.max(0, at - 70), at + 40).replace(/\s+/g, ' ')}...`)
    }
  }
  if (hits.length) {
    console.error(`[fail] a build for another network still names the public network's hosts (${hits.length}):`)
    for (const h of hits) console.error('  ' + h)
    console.error('Move the address into the network profile (infra/network.json, lib/network.ts) or the node list.')
    process.exitCode = 1
  } else {
    console.log(`[ok] ${files.length} files of a build for another network name no onchato.com host`)
  }
} finally {
  if (process.argv.includes('--keep')) console.log(`build kept in ${out}`)
  else rmSync(out, { recursive: true, force: true })
}
