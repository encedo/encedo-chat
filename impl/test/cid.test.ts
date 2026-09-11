/**
 * CID verification (`lib/cid.ts`).
 *
 * Every expected value here came from the real thing — `ipfs add
 * --cid-version=1 --raw-leaves` on the operator's own Kubo node — rather than
 * from this implementation or from a specification read twice. A hash checker
 * verified against its own arithmetic proves nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cidV1Raw, cidMatches, isVerifiableCid } from '../lib/cid.ts'

/** The deterministic 5000-byte pattern the vector below was produced from. */
const pattern = new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7 + 13) & 255))
const enc = new TextEncoder()

test('the CIDs match what a real IPFS node produced', async () => {
  assert.equal(await cidV1Raw(enc.encode('hello world')),
    'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')
  assert.equal(await cidV1Raw(new Uint8Array(0)),
    'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  assert.equal(await cidV1Raw(pattern),
    'bafkreickjstnsbx4l356nrmx6jtpqmxjpbiw7qyug7n5w5bkptaz4mk24e')
})

test('one byte different is a different CID', async () => {
  const tampered = Uint8Array.from(pattern)
  tampered[2500] ^= 0x01
  assert.equal(await cidMatches('bafkreickjstnsbx4l356nrmx6jtpqmxjpbiw7qyug7n5w5bkptaz4mk24e', tampered), false)
  assert.equal(await cidMatches('bafkreickjstnsbx4l356nrmx6jtpqmxjpbiw7qyug7n5w5bkptaz4mk24e', pattern), true)
})

test('what cannot be checked is REFUSED, never waved through', async () => {
  // The same bytes, added the default way, get a CIDv0 naming a dag-pb node
  // rather than the file. Verifying that means rebuilding UnixFS framing; this
  // module does not, and must therefore say no.
  const v0 = 'Qmd1xPth8p7CfyXUV18S6AmyBd3X4XhGaDctaLPQDgQrz9'
  assert.equal(isVerifiableCid(v0), false)
  assert.equal(await cidMatches(v0, pattern), false,
    'a verifier that answers "fine" for what it cannot check is worse than none')
  // Neither shape nor length may be guessed at.
  assert.equal(isVerifiableCid(''), false)
  assert.equal(isVerifiableCid('bafkrei'), false)
  assert.equal(isVerifiableCid('bafybeickjstnsbx4l356nrmx6jtpqmxjpbiw7qyug7n5w5bkptaz4mk24e'), false)
  assert.equal(isVerifiableCid('bafkreickjstnsbx4l356nrmx6jtpqmxjpbiw7qyug7n5w5bkptaz4mk24E'), false)
})

test('a verifiable CID is recognised as one', () => {
  assert.ok(isVerifiableCid('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'))
})
