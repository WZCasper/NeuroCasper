// Pure helpers around Telegram chat membership: interpreting
// my_chat_member/chat_member updates (both carry the same
// ChatMemberUpdated shape -- one for the bot's own membership, the other
// for any chat member's), safely embedding user-controlled text into an
// HTML-formatted message, and a narrow bio-based spam check used when
// deciding whether to greet or auto-ban a newly-joined member. Kept
// separate from src/handlers/telegram.ts (which wires these into the
// actual bot, with real API calls and no test coverage of its own -- see
// that file's other dozens of orchestration functions) so this specific
// logic can have real, isolated tests the way src/lib/message-templates.ts
// does for its own similarly-small pure-function surface.

import { DEFAULT_SPAM_PHRASES, normalizeSpamPhrase } from "./moderation-settings.js";

/** Mirrors python-telegram-bot's own reference chatmemberbot example
 * (docs.python-telegram-bot.org/en/stable/examples.chatmemberbot.html) for
 * interpreting a ChatMember's status: "member"/"administrator"/"creator"
 * always count as actually being in the chat, and "restricted" only counts
 * if its own is_member flag says so -- a restricted-but-not-a-member state
 * exists in the Bot API and behaves like not being in the chat for this
 * purpose (e.g. someone removed then re-invited under a restriction). */
export function isMemberStatus(member: { status: string; is_member?: boolean }): boolean {
  if (member.status === "member" || member.status === "administrator" || member.status === "creator") return true;
  if (member.status === "restricted") return member.is_member === true;
  return false;
}

/** Escapes the three characters Telegram's HTML parse_mode treats
 * specially. Needed anywhere user-controlled text (e.g. a Telegram
 * first_name, which a user can set to arbitrary text including markup-like
 * strings) is interpolated into a parse_mode: "HTML" message alongside
 * real formatting tags -- otherwise that text could inject its own tags
 * (e.g. a first_name of `<a href="evil">x</a>`) into the rendered message. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True if bio contains any of `phrases` (case- and spacing-insensitive
 * substring match). `phrases` is the chat's own list, see
 * src/lib/moderation-settings.ts; it defaults to the built-in list. A
 * missing/empty bio (undefined, e.g. because Telegram's privacy settings
 * hid it, or the user never set one) is never spam by this check -- absence
 * of information is not evidence of spam. Blank phrases are ignored: an empty
 * needle would match every bio (String#includes("") is true) and ban
 * everyone who joins. */
export function bioLooksLikeSpam(bio: string | undefined, phrases: readonly string[] = DEFAULT_SPAM_PHRASES): boolean {
  if (!bio) return false;
  const normalizedBio = normalizeSpamPhrase(bio);
  return phrases.some((phrase) => {
    const needle = normalizeSpamPhrase(phrase);
    return needle !== "" && normalizedBio.includes(needle);
  });
}
