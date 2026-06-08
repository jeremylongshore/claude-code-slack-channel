/**
 * slack-delivery.ts — Slack-facing glue for the reply-delivery outbox poller
 * (ccsc-o7x.3).
 *
 * The crash-safety epic (ccsc-o7x) makes a terminal turn's reply loss-proof:
 * the reply is recorded as a durable obligation (ccsc-o7x.2.1), drained by a
 * leased, retrying poller (ccsc-o7x.2.2), and made idempotent so a redelivery
 * after a lost ack never double-posts (ccsc-o7x.2.3). All of THAT logic lives
 * in the vendored `lib.ts` kernel (`makeIdempotentSend`,
 * `deliveryIdempotencyKey`) and `supervisor.ts` (`drainOutbox`).
 *
 * This module is the thin I/O adapter that binds that logic to a real Slack
 * `WebClient` — `findDelivered` (look up our own prior post by its stamped
 * idempotency key) and `post` (send with the key stamped into message
 * metadata). It is deliberately a sibling module, not inline in `server.ts`,
 * so it can be unit-tested against a faked `WebClient` without triggering
 * `server.ts`'s module-load side effects (token load, Socket Mode, `main()`).
 *
 * No Slack-SDK code crosses into `lib.ts`: the kernel stays vendorable by AGP;
 * this Slack glue stays in CCSC.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebClient } from '@slack/web-api'
import { DELIVERY_METADATA_EVENT_TYPE, type IdempotentSendDeps } from './lib.ts'

/** Shape of a `conversations.replies` message we care about — just the `ts` and
 *  the message `metadata` (returned when the request sets
 *  `include_all_metadata`). Narrowed locally because the Slack SDK types the
 *  reply union loosely. */
interface ReplyMessage {
  ts?: string
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> }
}

/** Build the production `IdempotentSendDeps` the outbox poller consumes, bound
 *  to a Slack `WebClient`.
 *
 *  - `findDelivered` scans the destination thread (`conversations.replies` with
 *    `include_all_metadata`) for a message we previously posted carrying our
 *    delivery `event_type` and a matching idempotency key. A hit means the reply
 *    already landed (e.g. a prior attempt posted but its ack was lost), so the
 *    redelivery must be a no-op — it returns the existing `ts`. No thread parent
 *    ⇒ `null` (a non-threaded post can't be looked up this way; the in-process
 *    lease still guards the live race, and CCSC sessions are thread-keyed so
 *    obligations carry a thread in practice).
 *  - `post` sends the reply with the idempotency key stamped into Slack message
 *    `metadata`, so a later `findDelivered` can recognise it.
 *
 *  The idempotency *decision* lives in `makeIdempotentSend` (lib.ts); this only
 *  supplies the two Slack calls it composes. */
export function createDeliverySendDeps(client: WebClient): IdempotentSendDeps {
  return {
    async findDelivered(channel: string, thread: string, key: string): Promise<string | null> {
      if (!thread) return null
      const res = await client.conversations.replies({
        channel,
        ts: thread,
        limit: 200,
        include_all_metadata: true,
      })
      const messages = (res.messages ?? []) as ReplyMessage[]
      for (const m of messages) {
        if (
          m.metadata?.event_type === DELIVERY_METADATA_EVENT_TYPE &&
          m.metadata.event_payload?.idempotency_key === key
        ) {
          return (m.ts as string) || 'delivered'
        }
      }
      return null
    },
    async post(obligation, key): Promise<void> {
      await client.chat.postMessage({
        channel: obligation.channel,
        text: obligation.payload,
        thread_ts: obligation.thread || undefined,
        unfurl_links: false,
        unfurl_media: false,
        metadata: {
          event_type: DELIVERY_METADATA_EVENT_TYPE,
          event_payload: { idempotency_key: key },
        },
      })
    },
  }
}
