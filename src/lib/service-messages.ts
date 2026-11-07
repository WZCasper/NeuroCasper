// Telegram's OWN service message announcing that a member joined or left a
// group -- the grey "X joined the group" / "X left the group" line Telegram
// itself inserts into the chat as an ordinary Message with
// new_chat_members / left_chat_member set, completely separate from this
// bot's own welcome/leave announcement text (channels.welcome_enabled /
// channels.leave_enabled, src/lib/moderation-settings.ts). A chat owner may
// want either, both, or neither: hide Telegram's own line while keeping the
// bot's own welcome message, or vice versa -- see
// channels.hide_service_messages in schema.sql.
//
// This file holds the pure check only (no I/O): whether a given message IS
// one of these two service-message kinds. src/handlers/telegram.ts owns the
// live deleteMessage call and the channels.hide_service_messages lookup.

import type { Message } from "grammy/types";

/** True if `message` is Telegram's own "a member joined" or "a member
 * left" service message -- i.e. it has new_chat_members or
 * left_chat_member set. Both fields are mutually exclusive on a single
 * Telegram Message (Bot API never sets more than one service-message kind
 * on the same update), so checking either is enough; takes a narrowed Pick
 * rather than the whole Message type so tests can pass a plain object. */
export function isJoinOrLeaveServiceMessage(
  message: Pick<Message, "new_chat_members" | "left_chat_member">,
): boolean {
  return (
    (Array.isArray(message.new_chat_members) && message.new_chat_members.length > 0) ||
    message.left_chat_member !== undefined
  );
}
