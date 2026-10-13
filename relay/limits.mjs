/**
 * limits.mjs - what a node will carry, per frame.
 *
 * The client bounds every frame it publishes at 64 KiB (SPEC.md 7.4), and
 * until 2026-10-12 that was the only bound: `maxMessageSize` was passed to
 * gossipsub and silently ignored (the option does not exist in 14.x; the
 * library bounds a whole inbound RPC, at 4 MB by default). So a node that
 * claimed a 64 KB cap enforced none. Two bounds now, both here:
 *
 *   MAX_FRAME_BYTES  one message. A PUSH past it is refused (ACK 0, nothing
 *                    published); a GossipSub message past it is ignored by the
 *                    topic validator - not forwarded, not delivered, and the
 *                    sender is not penalised for it (Ignore, not Reject: a
 *                    client's score decides nothing here and a penalty would
 *                    only add a graylist to debug).
 *   MAX_RPC_BYTES    one inbound RPC (several messages and control in one
 *                    length-prefixed frame): the library's own knob, lowered
 *                    from 4 MB so one socket cannot make the node buffer that
 *                    much before a single message is looked at.
 */

import { TopicValidatorResult } from '@libp2p/interface'

export const MAX_FRAME_BYTES = 65536
export const MAX_RPC_BYTES = 1 << 20

export const oversize = (data) => (data?.length ?? 0) > MAX_FRAME_BYTES

/** The validator installed for every topic the node carries. */
export function frameValidator(_topic, msg) {
  return oversize(msg?.data) ? TopicValidatorResult.Ignore : TopicValidatorResult.Accept
}
