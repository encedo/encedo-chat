/**
 * The IPFS client — the parsing and the failure modes, over an injected fetch.
 *
 * What is worth testing without a node: that a CID coming back from the network
 * is validated before being interpolated into a URL, that Kubo's line-delimited
 * /add output is read correctly (the LAST line is the root), and that a missing
 * file is reported as expiry rather than as an error — because for this store
 * expiry is the ordinary end of a file's life, and the UI has to tell a user to
 * ask for a resend rather than to retry.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { putBlob, getBlob, isCid, ExpiredError, IPFS_GET, IPFS_PUT, storeUrl, setStoreOrigin } from '../net/ipfs.ts'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ok = (body: string, status = 200) => async () => new Response(body, { status })

test('CIDv0 and CIDv1 are accepted, junk is not', () => {
  assert.ok(isCid(CID))
  assert.ok(isCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'))
  for (const bad of ['', 'x', '../../etc/passwd', 'bafy../..', 'Qm!', 'https://evil']) {
    assert.equal(isCid(bad), false, bad)
  }
})

test('a CID from the network is validated before it reaches a URL', async () => {
  // The response is attacker-influenced in the sense that it crosses a network;
  // interpolating it unchecked is how a path traversal starts.
  await assert.rejects(getBlob('../../api/v0/shutdown' as any), /not a CID/)
  await assert.rejects(putBlob(new Uint8Array(1), { fetchImpl: ok('{"Hash":"../../x"}') as any }), /no usable CID/)
})

test('/add returns line-delimited JSON — the LAST line is the root', async () => {
  const body = ['{"Name":"b","Hash":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG","Size":"262158"}',
                `{"Name":"b","Hash":"${CID}","Size":"524301"}`].join('\n')
  const r = await putBlob(new Uint8Array(4), { fetchImpl: ok(body) as any })
  assert.equal(r.cid, CID, 'the wrapping root, not the first block')
})

test('an HTTP error on upload is reported, not swallowed', async () => {
  await assert.rejects(putBlob(new Uint8Array(1), { fetchImpl: ok('nope', 413) as any }), /HTTP 413/)
})

test('a missing file is EXPIRED, not a failure', async () => {
  // The distinction drives what the UI tells the user: ask for a resend, or retry.
  for (const status of [404, 410]) {
    await assert.rejects(getBlob(CID, { fetchImpl: ok('', status) as any }), ExpiredError)
  }
  await assert.rejects(getBlob(CID, { fetchImpl: ok('', 502) as any }), /HTTP 502/)
})

test('a fetched blob comes back as bytes, unchanged', async () => {
  const bytes = new Uint8Array([1, 2, 3, 250])
  const got = await getBlob(CID, { fetchImpl: (async () => new Response(bytes)) as any })
  assert.deepEqual(got, bytes)
})

test('the fetch URL stays on our own origin', () => {
  assert.ok(IPFS_GET(CID).startsWith('/f/'), 'same-origin path, never the node')
  assert.ok(!IPFS_GET(CID).includes('ipfs.encedo.com'))
})

/**
 * The web must stay same-origin and a packaged build must not.
 *
 * `/f/<cid>` is "ask my own origin", which is true in a browser tab and a lie
 * inside `tauri://localhost`, where it resolves to a missing asset. That is the
 * whole of "Show does nothing and Download turns into an error" on the desktop:
 * one URL, three buttons, all dead. The default must not move, though — the
 * same-origin path is what keeps the store free of CORS and the IPFS node
 * invisible — so both halves are pinned here.
 */
test('the store is same-origin by default and absolute when told', () => {
  assert.equal(storeUrl(IPFS_PUT), '/f')
  assert.ok(storeUrl(IPFS_GET(CID)).startsWith('/f/'))

  setStoreOrigin('https://onchato.com')
  assert.equal(storeUrl(IPFS_PUT), 'https://onchato.com/f')
  assert.equal(storeUrl(IPFS_GET(CID)), `https://onchato.com/f/${CID}`)

  // A trailing slash is somebody's honest mistake, not a second path segment.
  setStoreOrigin('https://onchato.com/')
  assert.equal(storeUrl(IPFS_PUT), 'https://onchato.com/f')

  // Whatever it is set to, the node itself is never the address.
  assert.ok(!storeUrl(IPFS_GET(CID)).includes('ipfs.encedo.com'))

  setStoreOrigin('') // the default, restored for whatever runs next
  assert.equal(storeUrl(IPFS_PUT), '/f')
})
