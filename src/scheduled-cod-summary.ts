// Ежедневная сводка по играм Call of Duty для каждой группы с
// cod_summary_enabled -- вызывается из src/index.ts's scheduled() по
// cron-триггеру "0 8 * * *" (см. wrangler.toml), отдельно от
// */5-минутного триггера проверки стримов (src/scheduled.ts).
//
// ЧЕСТНО (см. обсуждение с владельцем бота, зафиксированное в коде
// src/lib/cod-client.ts/cod-session.ts): точный код игры (title) для
// Black Ops 7/Modern Warfare 4 не подтверждён, и у этой интеграции нет
// ни одного живого теста против реального Activision API -- этот файл
// запускает код, написанный по документированным паттернам, но
// неизбежно может столкнуться с ошибками, которые здесь предусмотрены
// (CodApiError с конкретной причиной), но не гарантированно покрывают
// каждый возможный сюрприз от недокументированного API.

import { Api } from "grammy";
import {
  getActivisionSession,
  listChannelsWithCodSummaryEnabled,
  listCodAuthorizationsByChannel,
} from "./db.js";
import { CodApiError, fetchWarzoneProfile, resolveCodTitleCode, type CodSession } from "./lib/cod-client.js";
import { extractLifetimeStats, formatDailySummaryMessage, formatMemberFailureLine, formatMemberStatsLine } from "./lib/cod-summary-formatting.js";
import { resolveCodSession } from "./lib/cod-session.js";
import { runWithConcurrency, DEFAULT_CONCURRENCY } from "./lib/concurrency.js";
import type { CodAuthorizationRow, ChannelRow, Env } from "./types.js";

/** Получает статистику ОДНОГО участника и возвращает уже готовую строку
 * для сводки -- успешную или с объяснением отказа, никогда не бросает
 * исключение наружу (CodApiError перехватывается здесь же и превращается
 * в formatMemberFailureLine), потому что один участник, чей тег
 * Activision не распознал или чей профиль закрыт, не должен ронять всю
 * сводку для остальных авторизованных в этом же чате. */
async function buildOneMemberLine(session: CodSession, titleCode: string, member: CodAuthorizationRow): Promise<string> {
  try {
    const raw = await fetchWarzoneProfile(session, titleCode, member.activision_tag);
    const stats = extractLifetimeStats(raw);
    return formatMemberStatsLine(member.display_name, member.activision_tag, stats);
  } catch (err) {
    if (err instanceof CodApiError) {
      console.error(
        `fetchWarzoneProfile failed for ${member.activision_tag} (user ${member.telegram_user_id}, channel ${member.channel_id}): ${err.reason} — ${err.message}`,
      );
      return formatMemberFailureLine(member.display_name, member.activision_tag, err.reason);
    }
    // Что-то совсем неожиданное (сетевой сбой самого fetch, а не отказ
    // Activision, который CodApiError уже покрывает) -- то же самое
    // честное отражение отказа, не притворяемся, что всё получилось.
    console.error(`Unexpected error fetching stats for ${member.activision_tag} (channel ${member.channel_id}):`, err);
    return formatMemberFailureLine(member.display_name, member.activision_tag, "unexpected_response");
  }
}

/** Собирает и отправляет сводку для ОДНОГО канала -- пропускает канал
 * целиком (без отправки чего-либо), если в нём пока нет ни одного
 * авторизованного участника: пустая сводка с одним заголовком не несёт
 * пользы и выглядела бы как сбой, а не как "пока некому показывать". */
async function sendSummaryForChannel(env: Env, api: Api, session: CodSession, channel: ChannelRow): Promise<void> {
  const members = await listCodAuthorizationsByChannel(env, channel.id);
  if (members.length === 0) return;

  const titleCode = resolveCodTitleCode(channel.cod_title_code);
  const lines = new Array<string>(members.length);
  // Пул по индексам [0..members.length), а не по самим объектам members
  // напрямую -- так каждая задача пишет результат строго в lines[index]
  // по заранее известному индексу, без необходимости искать позицию
  // члена обратно в members (что было бы и неэффективно, и опиралось бы
  // на сравнение объектов по ссылке).
  await runWithConcurrency(members.map((_, index) => index), DEFAULT_CONCURRENCY, async (index) => {
    const member = members[index];
    if (!member) return; // недостижимо: index всегда внутри границ members
    lines[index] = await buildOneMemberLine(session, titleCode, member);
  });

  const message = formatDailySummaryMessage(channel.title ?? String(channel.telegram_chat_id), lines);
  await api.sendMessage(channel.telegram_chat_id, message).catch((err) => {
    console.error(`sendMessage (daily CoD summary) failed for chat ${channel.telegram_chat_id}:`, err);
  });
}

/** Точка входа, вызываемая из src/index.ts's scheduled(). */
export async function runDailyCodSummary(env: Env): Promise<void> {
  const sessionRow = await getActivisionSession(env);
  const sessionResult = resolveCodSession(sessionRow);
  if (!sessionResult.ok) {
    // Не настроено вообще -- не ошибка, требующая внимания каждый день:
    // владелец либо ещё не дошёл до настройки, либо сознательно не
    // включал ни одной группы. Один тихий лог вместо шума -- ничего не
    // отправляется НИ В ОДНУ группу, пока сессия не настроена, даже если
    // у каких-то каналов cod_summary_enabled уже включён.
    console.log(`runDailyCodSummary: no usable Activision session (${sessionResult.reason}), skipping entirely`);
    return;
  }

  const channels = await listChannelsWithCodSummaryEnabled(env);
  if (channels.length === 0) return;

  const api = new Api(env.BOT_TOKEN);
  console.log(`runDailyCodSummary: sending daily summary to ${channels.length} channel(s)…`);

  // Каналы -- последовательно, а не через тот же пул DEFAULT_CONCURRENCY,
  // что и участники внутри sendSummaryForChannel: участники внутри ОДНОГО
  // канала уже используют до 6 одновременных соединений (см.
  // src/lib/concurrency.ts's doc-комментарий про потолок Cloudflare), так
  // что несколько каналов ОДНОВРЕМЕННО рисковали бы превысить этот же
  // потолок суммарно; при обычном числе каналов для одного владельца
  // последовательный проход по ним самим не станет узким местом.
  for (const channel of channels) {
    await sendSummaryForChannel(env, api, sessionResult.session, channel).catch((err) => {
      console.error(`sendSummaryForChannel failed for channel ${channel.id} (chat ${channel.telegram_chat_id}):`, err);
    });
  }
}
