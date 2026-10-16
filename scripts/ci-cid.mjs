/**
 * ci-cid.mjs - did CI build this web app for a release tag? (web-monitor.mjs)
 *
 * Two places say so, both written by `.github/workflows/desktop.yml`, job
 * `reproducible`, once two independent builds of the tag agree on the CID:
 *
 *   1. the release asset `reproducible-<tag>.md` - but a DRAFT release is
 *      listed only to tokens that can write the repository, and the monitor's
 *      token can only read, so between a tag and its publication the release
 *      is invisible to it;
 *   2. an Actions artifact named `web-cid-<tag>-<cid>` on that run - readable
 *      with `actions: read`, draft or not. The CID is in the NAME, so the
 *      listing answers without downloading (and unzipping) anything.
 *
 * Without (2) a served release awaiting approval read as ALARM ("nobody built
 * this") instead of PENDING whenever the release was still a draft - which is
 * exactly the window between deploy and approval (seen on v0.7.40).
 */

const ARTIFACT = /^web-cid-(v[0-9][0-9A-Za-z.\-]*)-([a-z2-7]{20,})$/

/** `web-cid-v0.7.40-bafk...` -> { tag, cid }, or null. */
export function parseCidArtifact(name) {
  const m = ARTIFACT.exec(name ?? '')
  return m ? { tag: m[1], cid: m[2] } : null
}

/**
 * The tag CI built `served` for, and when, or null.
 * `getJson(url, accept?)` fetches GitHub's API (authenticated by the caller);
 * `getText(url)` downloads a release asset.
 */
export async function findCiBuild(served, { repo, getJson, getText, log = () => {} }) {
  try {
    const rel = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=5`)
    for (const r of rel) {
      const asset = r.assets?.find((a) => a.name === `reproducible-${r.tag_name}.md`)
      if (!asset) continue
      const md = await getText(asset.url)
      const cid = md.match(/GitHub runner[^|]*\|\s*`([a-z0-9]+)`/)?.[1]
      if (cid === served) return { tag: r.tag_name, since: Date.parse(asset.created_at), via: 'release' }
    }
  } catch (e) { log(`(could not read the releases: ${e.message})`) }
  try {
    const runs = await getJson(`https://api.github.com/repos/${repo}/actions/workflows/desktop.yml/runs?event=push&per_page=10`)
    for (const run of runs.workflow_runs ?? []) {
      if (!/^v[0-9]/.test(run.head_branch ?? '')) continue // a tag push, not a branch
      const arts = await getJson(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`)
      for (const a of arts.artifacts ?? []) {
        const p = parseCidArtifact(a.name)
        if (p && p.tag === run.head_branch && p.cid === served && !a.expired) {
          return { tag: p.tag, since: Date.parse(a.created_at), via: 'artifact' }
        }
      }
    }
  } catch (e) { log(`(could not read the workflow artifacts: ${e.message})`) }
  return null
}
