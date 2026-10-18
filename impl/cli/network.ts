/**
 * network.ts - the network profile for the terminal client (lib/network.ts).
 *
 * The same file the app is built with, `infra/network.json`, unless
 * ONCHATO_NETWORK_PROFILE names another one. Read once, at import; a profile
 * that does not validate stops the client with the reason.
 */
import { readFileSync } from 'node:fs'
import { parseNetworkProfile } from '../lib/network.ts'

const file = process.env.ONCHATO_NETWORK_PROFILE ?? new URL('../../infra/network.json', import.meta.url)
export const NET = parseNetworkProfile(JSON.parse(readFileSync(file, 'utf8')))
