/**
 * bob.ts — software-identity peer "Bob" (dev/test). Thin entrypoint over
 * cli/software-peer.ts; key stays in bob.keystore.json (this folder).
 *   node bob/bob.ts <init [--handle bob]|pubkey|add-peer <h> <b64>|peers|topic <peer>|join <peer>>
 */

import { softwarePeerCli } from '../cli/software-peer.ts'

await softwarePeerCli(new URL('./bob.keystore.json', import.meta.url).pathname, 'bob')
