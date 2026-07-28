/**
 * carl.ts — software-identity peer "Carl" (dev/test). Thin entrypoint over
 * cli/software-peer.ts; key stays in carl.keystore.json (this folder).
 *   node carl/carl.ts <init [--handle carl]|pubkey|add-peer <h> <b64>|peers|topic <peer>|join <peer>>
 */

import { softwarePeerCli } from '../cli/software-peer.ts'

await softwarePeerCli(new URL('./carl.keystore.json', import.meta.url).pathname, 'carl')
