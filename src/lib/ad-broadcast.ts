// "📢 РЕКЛАМА": lets the two hardcoded super-admins (see super-admins.ts)
// compose a post and send it either into every registered group/channel
// directly, or as a private message to each distinct group owner. An
// image is never uploaded anywhere outside Telegram's own infrastructure --
// the whole "photo" is just the Telegram file_id captured when the
// super-admin sent it to the bot (see AdBroadcastRow's own comment in
// src/types.ts), re-used as-is via sendPhoto for every target.
import { GrammyError } from "grammy";
import type { Api } from "grammy";
import { listAllChannels, listDistinctChannelOwners } from "../db.js";
import type { AdTarget, Env } from "../types.js";

/** Europe/Minsk has been UTC+3 year-round (no DST) since 2011 -- the one
 * concrete timezone fact on record for this bot's own operator, and the
 * only one asked for anywhere in the schedule-time prompt, so there is no
 * silent/ambiguous assumption here: the prompt itself states the zone. */
const MINSK_UTC_OFFSET_HOURS = 3;

const SCHEDULE_TIME_FORMAT_HINT = "25.11.2026 18:00";

export interface AdBroadcastContent {
  text: string | null;
  photoFileId: string | null;
}

/** True only if there is something to actually send -- at least one of
 * text/photo. Mirrors the CHECK constraint on ad_broadcasts in schema.sql,
 * applied here too so an empty/invalid post is rejected before it ever
 * reaches the database or a live sendMessage/sendPhoto call. */
export function isAdBroadcastContentValid(content: AdBroadcastContent): boolean {
  return Boolean(content.text?.trim()) || Boolean(content.photoFileId);
}

export interface ParsedAdScheduleTime {
  /** "YYYY-MM-DD HH:MM:SS", UTC, in exactly the shape SQLite's own
   * datetime('now') produces -- ready to store as-is and compare with a
   * plain `send_at <= datetime('now')`, the same string-comparison
   * approach pending_message_deletions.delete_at already relies on. */
  utcSendAt: string;
  /** Echoed back on the confirmation screen, e.g. "25.11.2026 18:00 (Минск, UTC+3)". */
  displayMinsk: string;
}

export type ParseAdScheduleTimeResult =
  | { ok: true; value: ParsedAdScheduleTime }
  | { ok: false; error: string };

/** Parses "ДД.ММ.ГГГГ ЧЧ:ММ", interpreted as Europe/Minsk time (the zone is
 * stated explicitly in the prompt, never assumed silently), into an
 * absolute UTC instant. `now` is injected (rather than `new Date()` read
 * internally) purely so this stays a pure, deterministic function for
 * testing -- the one caller in telegram.ts passes the real current time. */
export function parseAdScheduleTime(raw: string, now: Date): ParseAdScheduleTimeResult {
  const match = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    return {
      ok: false,
      error: `Не понял формат. Напишите дату и время по Минску (UTC+3) так: ${SCHEDULE_TIME_FORMAT_HINT}`,
    };
  }
  const [, dayStr, monthStr, yearStr, hourStr, minuteStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return {
      ok: false,
      error: `Дата или время вне допустимых значений. Напишите так: ${SCHEDULE_TIME_FORMAT_HINT}`,
    };
  }

  // Date.UTC silently rolls an impossible day (31 февраля и т.п.) into the
  // next month instead of erroring -- catch that by re-reading the
  // constructed date's own fields back and comparing to what was typed.
  const dateOnlyCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    dateOnlyCheck.getUTCFullYear() !== year ||
    dateOnlyCheck.getUTCMonth() !== month - 1 ||
    dateOnlyCheck.getUTCDate() !== day
  ) {
    return { ok: false, error: `Такой даты не существует. Напишите так: ${SCHEDULE_TIME_FORMAT_HINT}` };
  }

  const asUtcMillis = Date.UTC(year, month - 1, day, hour - MINSK_UTC_OFFSET_HOURS, minute, 0);
  if (asUtcMillis <= now.getTime()) {
    return { ok: false, error: "Это время уже в прошлом. Укажите дату и время в будущем." };
  }

  const utcSendAt = new Date(asUtcMillis).toISOString().slice(0, 19).replace("T", " ");
  // The outer regex match already guarantees all five groups are present
  // (none of them is optional in the pattern) -- the non-null assertions
  // below are safe, not a bypass of a real possibility.
  const displayMinsk =
    `${dayStr!.padStart(2, "0")}.${monthStr!.padStart(2, "0")}.${year} ` +
    `${hourStr!.padStart(2, "0")}:${minuteStr!.padStart(2, "0")} (Минск, UTC+3)`;
  return { ok: true, value: { utcSendAt, displayMinsk } };
}

/** The reverse of parseAdScheduleTime's conversion -- turns a stored UTC
 * send_at string back into the Minsk-time display the super-admin
 * originally typed, for the confirm screen and the "📋 Запланированные
 * рассылки" list. Deliberately re-derived from the stored UTC value
 * rather than threading the original display string through the session
 * too -- one source of truth. */
export function formatUtcSendAtAsMinsk(utcSendAt: string): string {
  // utcSendAt is "YYYY-MM-DD HH:MM:SS" with no timezone suffix -- treat it
  // as UTC explicitly by turning it into a parseable ISO string first.
  const asUtcDate = new Date(`${utcSendAt.replace(" ", "T")}Z`);
  const minsk = new Date(asUtcDate.getTime() + MINSK_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(minsk.getUTCDate())}.${pad(minsk.getUTCMonth() + 1)}.${minsk.getUTCFullYear()} ` +
    `${pad(minsk.getUTCHours())}:${pad(minsk.getUTCMinutes())} (Минск, UTC+3)`
  );
}

interface AdBroadcastRecipient {
  chatId: number;
  label: string;
}

/** Resolves an AdTarget into the actual Telegram chat ids to send to --
 * every registered group/channel directly for "groups", or one private
 * chat per DISTINCT owner for "admins" (an owner of three groups is
 * listed, and messaged, once). */
async function resolveAdBroadcastRecipients(env: Env, target: AdTarget): Promise<AdBroadcastRecipient[]> {
  if (target === "groups") {
    const channels = await listAllChannels(env);
    return channels.map((c) => ({ chatId: c.telegram_chat_id, label: c.title ?? String(c.telegram_chat_id) }));
  }
  const owners = await listDistinctChannelOwners(env);
  return owners.map((u) => ({
    chatId: u.telegram_user_id,
    label: u.username ? `@${u.username}` : (u.first_name ?? String(u.telegram_user_id)),
  }));
}

async function sendAdBroadcastToChat(api: Api, chatId: number, content: AdBroadcastContent): Promise<void> {
  if (content.photoFileId) {
    await api.sendPhoto(chatId, content.photoFileId, content.text ? { caption: content.text } : undefined);
    return;
  }
  // isAdBroadcastContentValid guarantees text is non-empty whenever
  // photoFileId is absent -- this branch is never reached with both null.
  await api.sendMessage(chatId, content.text as string);
}

/** Why one specific recipient's send failed, in plain Russian -- an honest
 * per-recipient reason rather than a blanket "не удалось доставить".
 * Telegram's well-known, real constraint ("bot can't initiate conversation
 * with a user") is the single most likely failure for the "admins" target:
 * a bot can never DM someone who has never opened a private chat with it
 * first, even if that person is a known, registered channel owner -- this
 * is surfaced here rather than masked as a generic failure, in line with
 * reporting exactly what did and didn't happen. */
function describeAdSendFailure(err: unknown): string {
  if (err instanceof GrammyError) {
    const description = err.description;
    if (description.includes("bot can't initiate conversation") || description.includes("bot was blocked")) {
      return "бот не может написать первым -- этот человек никогда не открывал личный диалог с ботом";
    }
    if (description.includes("chat not found")) {
      return "чат не найден (возможно, бота уже удалили из этой группы)";
    }
    if (description.includes("not enough rights")) {
      return "боту не хватает прав отправлять сообщения в этом чате";
    }
    if (description.includes("user is deactivated")) {
      return "аккаунт этого человека удалён в Telegram";
    }
    return description;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface AdBroadcastOutcome {
  target: AdTarget;
  totalTargets: number;
  succeeded: number;
  failures: Array<{ label: string; reason: string }>;
}

/** Sends `content` to every recipient resolved from `target`, in sequence,
 * with full per-recipient error isolation -- one failed send never stops
 * the rest, and nothing here retries a failed send on its own (a delayed
 * broadcast that was due gets attempted exactly once by the cron sweep;
 * see deleteAdBroadcast's own comment in src/db.ts for why). Returns a
 * complete, honest tally -- callers must show it to the super-admin
 * rather than claim blanket success. */
export async function broadcastAd(
  env: Env,
  api: Api,
  target: AdTarget,
  content: AdBroadcastContent,
): Promise<AdBroadcastOutcome> {
  const recipients = await resolveAdBroadcastRecipients(env, target);
  let succeeded = 0;
  const failures: Array<{ label: string; reason: string }> = [];
  for (const recipient of recipients) {
    try {
      await sendAdBroadcastToChat(api, recipient.chatId, content);
      succeeded += 1;
    } catch (err) {
      failures.push({ label: recipient.label, reason: describeAdSendFailure(err) });
    }
  }
  return { target, totalTargets: recipients.length, succeeded, failures };
}

const MAX_FAILURES_LISTED = 20;

/** The results message shown (or DMed, for a scheduled broadcast) to the
 * super-admin who sent it -- names exactly what happened, never a blanket
 * "готово". Caps the listed failures so one broadcast with many
 * unreachable targets still fits in one Telegram message (4096-char
 * limit). */
export function formatAdBroadcastSummary(outcome: AdBroadcastOutcome): string {
  const targetLabel = outcome.target === "groups" ? "во все группы" : "админам групп (в личку)";
  const lines = [
    `📢 Рассылка завершена (${targetLabel}).`,
    `Доставлено: ${outcome.succeeded} из ${outcome.totalTargets}.`,
  ];
  if (outcome.failures.length > 0) {
    lines.push("", `Не доставлено (${outcome.failures.length}):`);
    for (const failure of outcome.failures.slice(0, MAX_FAILURES_LISTED)) {
      lines.push(`• ${failure.label}: ${failure.reason}`);
    }
    if (outcome.failures.length > MAX_FAILURES_LISTED) {
      lines.push(`…и ещё ${outcome.failures.length - MAX_FAILURES_LISTED}.`);
    }
  }
  return lines.join("\n");
}
