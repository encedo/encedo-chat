/**
 * scripts/ci-cid.mjs - how the web monitor tells "CI built this for a tag"
 * from "nobody built this". A draft release is invisible to the monitor's
 * read-only token, so the run's `web-cid-<tag>-<cid>` artifact must answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCiBuild, parseCidArtifact } from '../../scripts/ci-cid.mjs'

const CID = 'bafkreigxwtpiv5f2j7vqyvfors2gjpbt3galhjemwwurmcqja7zpu7lsvy'
const OTHER = 'bafkreicqe5rwevjzjxd7xbej6rllte3hc4sxauls3hjk6hbe3ffsoftsmi'
const REPO = 'encedo/encedo-chat'

/** A fake GitHub: published releases (drafts omitted, as for a read-only token) and Desktop runs. */
function github({ releases = [] as any[], runs = [] as any[], artifacts = {} as Record<number, any[]> } = {}) {
  return {
    repo: REPO,
    getJson: async (u: string) => {
      if (u.includes('/releases?')) return releases
      if (u.includes('/workflows/desktop.yml/runs')) return { workflow_runs: runs }
      const m = u.match(/\/actions\/runs\/(\d+)\/artifacts/)
      if (m) return { artifacts: artifacts[Number(m[1])] ?? [] }
      throw new Error('unexpected ' + u)
    },
    getText: async () => `| web build, GitHub runner (Node 24) | \`${OTHER}\` |`,
  }
}

test('an artifact name carries the tag and the CID, and nothing else parses', () => {
  assert.deepEqual(parseCidArtifact(`web-cid-v0.7.40-${CID}`), { tag: 'v0.7.40', cid: CID })
  assert.equal(parseCidArtifact('web-dist'), null)
  assert.equal(parseCidArtifact(`web-cid-main-${CID}`), null, 'a branch is not a release tag')
  assert.equal(parseCidArtifact(`web-cid-v0.7.40-NOT-A-CID`), null)
})

test('a draft release (not listed) is still found through its run artifact - PENDING, not ALARM', async () => {
  const gh = github({
    releases: [], // the draft is invisible to a read-only token
    runs: [{ id: 7, head_branch: 'v0.7.40' }],
    artifacts: { 7: [{ name: 'web-dist', created_at: '2026-10-16T08:40:00Z' },
      { name: `web-cid-v0.7.40-${CID}`, created_at: '2026-10-16T08:45:00Z', expired: false }] },
  })
  assert.deepEqual(await findCiBuild(CID, gh), { tag: 'v0.7.40', since: Date.parse('2026-10-16T08:45:00Z'), via: 'artifact' })
})

test('the published release asset still answers first', async () => {
  const gh = github({ releases: [{ tag_name: 'v0.7.39', assets: [{ name: 'reproducible-v0.7.39.md', url: 'x', created_at: '2026-10-15T18:30:00Z' }] }] })
  assert.deepEqual(await findCiBuild(OTHER, gh), { tag: 'v0.7.39', since: Date.parse('2026-10-15T18:30:00Z'), via: 'release' })
})

test('code nobody built stays unknown - the monitor says ALARM', async () => {
  const gh = github({
    runs: [{ id: 7, head_branch: 'v0.7.40' }, { id: 8, head_branch: 'main' }],
    artifacts: {
      7: [{ name: `web-cid-v0.7.40-${OTHER}`, created_at: 'x' }],
      8: [{ name: `web-cid-v0.7.40-${CID}`, created_at: 'x' }], // from a branch run: not a release
    },
  })
  assert.equal(await findCiBuild(CID, gh), null)
  const mismatched = github({ runs: [{ id: 9, head_branch: 'v0.7.41' }], artifacts: { 9: [{ name: `web-cid-v0.7.40-${CID}`, created_at: 'x' }] } })
  assert.equal(await findCiBuild(CID, mismatched), null, 'an artifact naming another tag than its run is not believed')
  const expired = github({ runs: [{ id: 7, head_branch: 'v0.7.40' }], artifacts: { 7: [{ name: `web-cid-v0.7.40-${CID}`, created_at: 'x', expired: true }] } })
  assert.equal(await findCiBuild(CID, expired), null)
})
