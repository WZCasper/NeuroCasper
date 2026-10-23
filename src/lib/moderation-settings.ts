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
// Leave message -- the mirror of the welcome message above, for the
// opposite event (a member leaving or being removed). Sent as a plain
// message only (no profile photo -- there is no equivalent reason to
// attach one for someone who just left), so it has no caption-length
// concern the way the welcome message does; it keeps the same
// WELCOME_TEMPLATE_MAX_LENGTH-style cap purely for a consistent editing
// experience in /settings, not because of any Telegram API limit here.
// ---------------------------------------------------------------------------

/** Shown in the group when a member leaves or is removed, and the chat has
 * no custom leave text. Plain text on purpose (sent without parse_mode),
 * same reasoning as DEFAULT_WELCOME_TEMPLATE above. No {registered}
 * placeholder here -- an approximate account-registration date isn't
 * relevant information about someone who just left. */
export const DEFAULT_LEAVE_TEMPLATE = "👋 {name} ({username}) покинул(а) чат «{chat}».";

/** Placeholders the leave text may use. Deliberately a subset of
 * WelcomeVars (no `registered`) rather than reusing that interface
 * directly, so a future change to one template's placeholder set can't
 * silently affect the other. */
export interface LeaveVars {
  /** First name plus last name, if any. */
  name: string;
  /** "@nick", or a "not set" marker when the member has none. */
  username: string;
  /** The chat's title. */
  chat: string;
}

/** Upper bound for a custom leave text. Same numeric value as
 * WELCOME_TEMPLATE_MAX_LENGTH, kept as its own named constant (rather than
 * aliased to it) so the two can be changed independently later without
 * one silently dragging the other along. */
export const LEAVE_TEMPLATE_MAX_LENGTH = 900;

export function resolveLeaveTemplate(stored: string | null | undefined): string {
  return stored !== null && stored !== undefined && stored.trim() !== "" ? stored : DEFAULT_LEAVE_TEMPLATE;
}

export function renderLeaveText(template: string, vars: LeaveVars): string {
  return renderPlaceholders(template, { ...vars });
}

export type LeaveTemplateValidation = { ok: true; template: string } | { ok: false; error: string };

export function validateLeaveTemplate(input: string): LeaveTemplateValidation {
  const template = input.trim();
  if (template === "")
    return { ok: false, error: "Текст не может быть пустым. Отправьте новый текст уведомления о выходе." };
  if (template.length > LEAVE_TEMPLATE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Слишком длинно: ${template.length} символов, максимум ${LEAVE_TEMPLATE_MAX_LENGTH}. Сократите текст и отправьте снова.`,
    };
  }
  return { ok: true, template };
}

// ---------------------------------------------------------------------------
// Spam phrases
// ---------------------------------------------------------------------------

/** Phrases that, found in a new member's bio, mark the account as spam.
 * Covers loan/debt solicitation, "need any job" touting, and (from the
 * second batch added below) the broader catalog of scam/get-rich-quick,
 * fake-job, phishing, gambling and crypto-fraud bio patterns the bot was
 * asked to recognize. A match means an automatic 30-day ban, so this is a
 * deliberately chosen list rather than a generic keyword blocklist -- a
 * false positive hits a real person. Already normalized (see
 * normalizeSpamPhrase). The chat's owner extends or trims this list in the
 * bot; see addSpamPhrases below for how additions are validated. */
export const DEFAULT_SPAM_PHRASES: readonly string[] = [
  // --- original list: loan/debt solicitation, "need any job" touting ---
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
  // --- scam/get-rich-quick, fake-job, phishing, gambling, crypto-fraud ---
  "ищу человека в команду",
  "работа на дому от 2 до 3 часов в день",
  "заработок без вложений",
  "доход от",
  "доходность от",
  "заработок от",
  "прибыль от",
  "пассивный доход от",
  "выплаты от",
  "стабильный доход",
  "гарантированный доход",
  "высокий доход",
  "ежедневный доход",
  "доход без риска",
  "легкий заработок для студентов и мам в декрете",
  "ставь плюс в лс и я расскажу подробнее",
  "подробности в закрепе",
  "смотри описание профиля",
  "переходи по ссылке в шапке профиля",
  "раздача токенов",
  "бесплатный эйрдроп",
  "забери свой бонус по ссылке",
  "сливаю приватную схему заработка",
  "слив платных курсов бесплатно",
  "точный счет на сегодняшний матч",
  "проходимость сигналов 99%",
  "гарантированный выигрыш в казино",
  "взлом алгоритмов слотов",
  "криптоарбитраж с доходностью от 20% в день",
  "ищем тестировщиков мобильных приложений",
  "простая работа: ставить лайки и писать отзывы",
  "набор сотрудников на удаленку",
  "нужны люди для приема смс и регистрации аккаунтов",
  "вывод средств без комиссии",
  "получи свой первый вывод уже сегодня",
  "инвестиции под высокий процент",
  "пассивный доход от 100% в месяц",
  "пиши слово «работа» мне в личку",
  "жду тебя в своем приватном канале",
  "подпишись, чтобы не потерять",
  "только сегодня бесплатно",
  "осталось всего 3 места",
  "ты еще здесь? жми на кнопку ниже",
  "первым 10 человек дарю гайд",
  "получи чек-лист по заработку",
  "нужны расклейщики / курьеры (высокая оплата)",
  "сомнительные вакансии с оплатой на карту ежедневно",
  "нужен менеджер по работе с клиентами (без опыта)",
  "уникальная система умножения баланса",
  "бесплатные сигналы на фьючерсы",
  "забери промокод на депозит",
  "оплата сразу после выполнения задачи",
  "срочный набор в проект",
  "тебе пришло личное приглашение",
  "нашел баг в системе, делюсь бесплатно",
  "выиграй iphone за пару кликов",
  "подтверди согласие и получи подарок",
  "твой аккаунт выбран для участия в акции",
  "слив инсайдерской информации",
  "принимаем заливы на карты",
  "работа с депозитами: умножу твой баланс в 5 раз",
  "помогу закрыть долги и кредиты",
  "гарантия возврата средств 100%",
];

/** A phrase shorter than this would match a huge share of ordinary bios
 * ("тел", "ищу") and ban real people, so it is refused. */
export const SPAM_PHRASE_MIN_LENGTH = 4;
export const SPAM_PHRASE_MAX_LENGTH = 60;
/** How many phrases buildSpamPhraseListView (src/handlers/telegram.ts)
 * shows per page. There is deliberately no cap on the total number of
 * phrases a chat can store (addSpamPhrases below never rejects for being
 * "too many") -- the list screen paginates instead, which is what actually
 * keeps it within Telegram's 100-buttons-per-message limit regardless of
 * how large the list grows, rather than an arbitrary stored-phrase ceiling
 * that would have had to be picked without knowing how many phrases any
 * given chat owner actually wants. */
export const SPAM_PHRASE_PAGE_SIZE = 20;

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

export type SpamPhraseSkipReason = "too_short" | "too_long" | "duplicate";

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

// ---------------------------------------------------------------------------
// Auto-deletion of welcome messages
// ---------------------------------------------------------------------------

/** Default delay before a welcome message is deleted: 10 minutes. The
 * channels column defaults to the same number (migrations/007). */
export const DEFAULT_WELCOME_DELETE_AFTER_SECONDS = 600;

/** Longest configurable delay: 24 hours. Telegram's deleteMessage only works
 * on messages sent less than 48 hours ago, so anything longer could silently
 * never happen; 24 h leaves a wide margin for cron lag. */
export const WELCOME_DELETE_AFTER_MAX_SECONDS = 24 * 60 * 60;

export type DeleteAfterValidation = { ok: true; seconds: number } | { ok: false; error: string };

/** Parses the owner's reply (minutes, "0" = never delete) into seconds.
 * Plain non-negative decimal only -- no hex, exponent, sign or text. */
export function validateWelcomeDeleteAfterMinutes(input: string): DeleteAfterValidation {
  const trimmed = input.trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return { ok: false, error: "Введите число минут (0 — не удалять). Например: 10" };
  }
  const seconds = Math.round(Number(trimmed.replace(",", ".")) * 60);
  if (seconds > WELCOME_DELETE_AFTER_MAX_SECONDS) {
    return {
      ok: false,
      error:
        `Слишком долго: максимум ${WELCOME_DELETE_AFTER_MAX_SECONDS / 60} минут (24 часа) — ` +
        "Telegram позволяет боту удалять только сообщения не старше 48 часов.",
    };
  }
  return { ok: true, seconds };
}

/** Seconds -> short Russian phrase; 0 is shown as "не удалять", not "0 мин". */
export function formatDeleteAfter(seconds: number): string {
  if (seconds <= 0) return "не удалять";
  if (seconds % 60 === 0) return `${seconds / 60} мин`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} мин ${rest} сек` : `${rest} сек`;
}
