/**
 * Chat SDK bridge — turns a Chat SDK `Thread` into a delta `Channel`.
 *
 * The Chat SDK (`chat` npm package) is the message layer: it owns the platform
 * adapters (Slack, Discord, Telegram, WhatsApp, Teams, …), webhook routing, and
 * the thread/message model. A Chat SDK `Thread` is already recipient-bound, and
 * its outbound primitive is `thread.post(text)` — which maps exactly onto delta's
 * `Channel.sendMessage(message, ctx)`. So this bridge is thin.
 *
 * Deliberately structural: we depend on the *shape* `{ post(text) }`, not on the
 * `chat` package itself. delta-agents stays a focused governance library with no
 * Chat SDK dependency; the bot application installs `chat`, and passes its live
 * `Thread` (from an `onNewMention` / `onDirectMessage` / `onSubscribedMessage`
 * handler) into `createChatSdkChannel`. Any object with a `post` method works.
 *
 * Inbound (a platform message → a delta task) lives in the bot's Chat SDK event
 * handler: it calls `delta.send({ goal: message.text, agentName })` with a
 * channel built from the same thread so the agent can reply in-context.
 */

import { Ok, Err } from "slang-ts";
import type { Channel, ChannelType } from "../authoring/types";

/**
 * The minimal slice of a Chat SDK `Thread` delta needs to send a message.
 * A real Chat SDK `Thread` satisfies this (its `post` also accepts an
 * `AsyncIterable<string>` for streaming, which delta does not use).
 */
export type ChatThread = {
  post: (text: string) => Promise<unknown>;
};

/**
 * Build a delta `Channel` backed by a live Chat SDK thread. `sendMessage`
 * forwards to `thread.post`; a thrown transport error becomes an `Err` so the
 * engine treats a failed send as a governed failure (never a silent success).
 */
export const createChatSdkChannel = ({
  type,
  thread,
  requiresApproval,
}: {
  type: ChannelType;
  thread: ChatThread;
  /** Gate messages on this channel behind human approval (e.g. customer-facing). */
  requiresApproval?: boolean;
}): Channel => ({
  type,
  enabled: true,
  ...(requiresApproval !== undefined ? { requiresApproval } : {}),
  sendMessage: async (message) => {
    try {
      await thread.post(message);
      return Ok(undefined);
    } catch (e) {
      return Err(`chat-sdk post failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});
