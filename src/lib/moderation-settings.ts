// Per-chat moderation settings: the welcome message shown to new group
// members and the list of spam phrases checked against a new member's bio.
// Both ship with built-in defaults (below) that the chat's owner can then
// edit inside the bot: /settings -> the chat -> «👥 Модерация группы».
//
// Storage (channels table, see migrations/005_add_moderation_settings.sql):
// welcome_template and spam_phrases are NULL until the owner changes them,
// and NULL means "use the built-in default" -- so a chat that never touched
// these settings keeps following whatever the defaults here become, and
// "reset to default" is simply writing NULL back. spam_phrases holds a JSON
// array of strings; an empty array ("[]") is a deliberate, different state
// from NULL: the owner removed every phrase, so nothing is matched.
//
// Everything here is pure (no I/O) so it can be tested in isolation; the
// orchestration that reads/writes the database and talks to Telegram lives
// in src/handlers/telegram.ts.

import { renderPlaceholders } from "./message-templates.js";

// ---------------------------------------------------------------------------
// Welcome message
// ---------------------------------------------------------------------------

/** Shown to a new member when the chat has no custom welcome text. Plain
 * text on purpose (sent without parse_mode): the owner can type anything,
 * including "<" or "&", without it being interpreted as markup. */
export const DEFAULT_WELCOME_TEMPLATE =
  "👋 {name}, добро пожаловать в чат!\n\n" +
  "Ник: {username}\n" +
  "Дата регистрации в Telegram: {registered}\n\n" +
  "Рады видеть вас здесь — надеемся, вам будет тут интересно и уютно. " +
  "Если возникнут вопросы, не стесняйтесь спрашивать!";

/** Placeholders the welcome text may use (documented to the owner in the
 * edit prompt; anything else in braces is left as typed, so a typo stays
 * visible instead of silently disappearing). */
export interface WelcomeVars {
  /** First name plus last name, if any. */
  name: string;
  /** "@nick", or a "not set" marker when the member has none. */
  username: string;
  /** Approximate registration date, already formatted (see
   * registration-date-estimate.ts). */
  registered: string;
  /** The chat's title. */
  chat: string;
}

/** Upper bound for a custom welcome text. The welcome goes out as a photo
 * caption when the member has a profile photo, and Telegram caps captions
 * at 1024 characters (after substituting the placeholders), so the template
 * itself is kept well under that; a rendered text that still ends up over
 * the caption limit is sent as a plain message without the photo instead
 * (see handleChatMemberUpdate in src/handlers/telegram.ts). */
export const WELCOME_TEMPLATE_MAX_LENGTH = 900;

/** Telegram's limit for a photo caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function resolveWelcomeTemplate(stored: string | null | undefined): string {
  return stored !== null && stored !== undefined && stored.trim() !== "" ? stored : DEFAULT_WELCOME_TEMPLATE;
}

export function renderWelcomeText(template: string, vars: WelcomeVars): string {
  return renderPlaceholders(template, { ...vars });
}

export type WelcomeTemplateValidation = { ok: true; template: string } | { ok: false; error: string };

export function validateWelcomeTemplate(input: string): WelcomeTemplateValidation {
  const template = input.trim();
  if (template === "") return { ok: false, error: "Текст не может быть пустым. Отправьте новый текст приветствия." };
  if (template.length > WELCOME_TEMPLATE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Слишком длинно: ${template.length} символов, максимум ${WELCOME_TEMPLATE_MAX_LENGTH}. Сократите текст и отправьте снова.`,
    };
  }
  return { ok: true, template };
}

// ---------------------------------------------------------------------------
// Spam phrases
// ---------------------------------------------------------------------------

/** Phrases that, found in a new member's bio, mark the account as spam.
 * Deliberately narrow: they cover the two categories the bot was asked to
 * catch (soliciting loans/debts, and "need any job" touting) rather than a
 * broad keyword blocklist, because a match means an automatic 30-day ban
 * and a false positive hits a real person. Already normalized (see
 * normalizeSpamPhrase). The chat's owner extends or trims this list in the
 * bot. */
export const DEFAULT_SPAM_PHRASES: readonly string[] = [
  "деньги в долг",
  "дам в долг",
  "деньги под расписку",
  "займ на карту",
  "займы на карту",
  "займ без отказа",
  "кредит без отказа",
  "нужна работа",
  "нужна подработка",
  "ищу работу",
  "ищу подработку",
  "подработка для всех",
  "работа для всех",
  "работа без опыта",
];

/** At most this many phrases per chat: every phrase is a button on the
 * list screen, and Telegram allows 100 buttons per message. */
export const MAX_SPAM_PHRASES = 50;
/** A phrase shorter than this would match a huge share of ordinary bios
 * ("тел", "ищу") and ban real people, so it is refused. */
export const SPAM_PHRASE_MIN_LENGTH = 4;
export const SPAM_PHRASE_MAX_LENGTH = 60;

/** Canonical form used both when storing a phrase and when matching it
 * against a bio: lowercase, runs of whitespace collapsed to one space,
 * trimmed. Matching is therefore case- and spacing-insensitive. */
export function normalizeSpamPhrase(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Reads the stored value. NULL/undefined -> the built-in defaults. A stored
 * value that isn't a JSON array of strings (corrupted, hand-edited) also
 * falls back to the defaults rather than throwing or silently matching
 * nothing. An empty array is honored as "no phrases". */
export function resolveSpamPhrases(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined) return [...DEFAULT_SPAM_PHRASES];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // fall through to the defaults
  }
  return [...DEFAULT_SPAM_PHRASES];
}

export function serializeSpamPhrases(phrases: readonly string[]): string {
  return JSON.stringify(phrases);
}

export type SpamPhraseSkipReason = "too_short" | "too_long" | "duplicate" | "limit_reached";

export interface AddSpamPhrasesResult {
  /** The full list after adding. */
  phrases: string[];
  /** Phrases actually added, in normalized form. */
  added: string[];
  /** Lines that were refused, with why. Blank lines are ignored, not listed. */
  skipped: Array<{ phrase: string; reason: SpamPhraseSkipReason }>;
}

/** Adds phrases from free text, one per line. Each line is normalized and
 * checked independently, so one bad line doesn't reject the rest. */
export function addSpamPhrases(current: readonly string[], rawInput: string): AddSpamPhrasesResult {
  const phrases = [...current];
  const added: string[] = [];
  const skipped: AddSpamPhrasesResult["skipped"] = [];

  for (const line of rawInput.split(/\r?\n/)) {
    const phrase = normalizeSpamPhrase(line);
    if (phrase === "") continue;
    if (phrase.length < SPAM_PHRASE_MIN_LENGTH) skipped.push({ phrase, reason: "too_short" });
    else if (phrase.length > SPAM_PHRASE_MAX_LENGTH) skipped.push({ phrase, reason: "too_long" });
    else if (phrases.includes(phrase)) skipped.push({ phrase, reason: "duplicate" });
    else if (phrases.length >= MAX_SPAM_PHRASES) skipped.push({ phrase, reason: "limit_reached" });
    else {
      phrases.push(phrase);
      added.push(phrase);
    }
  }
  return { phrases, added, skipped };
}

/** Returns the list without the phrase at `index`, or null if `index` isn't
 * a valid position (e.g. a stale button pressed after the list changed
 * shrunk it). Position-based rather than value-based on purpose, even
 * though a position can in principle point at a different phrase than the
 * one an owner saw if the list changed between their screen being rendered
 * and a delete button being tapped: Telegram's callback_data is capped at
 * 64 bytes, and a phrase up to SPAM_PHRASE_MAX_LENGTH (60) Cyrillic
 * characters can be well over twice that in UTF-8, so the full phrase
 * cannot be round-tripped through a button's data at all. The channel row
 * (and so this list) is re-read fresh on every callback in
 * handleModerationCallback, so the only actual risk window is between one
 * screen render and one button tap by the SAME owner -- the same
 * already-accepted risk every other by-position list in this bot's
 * settings UI carries for its single owner (this file has no multi-editor
 * chats to guard against), not a new or larger one introduced here. */
export function removeSpamPhraseAt(current: readonly string[], index: number): string[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
  return current.filter((_, i) => i !== index);
}
