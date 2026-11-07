// Извлечение интересующих полей из ответа Activision stats API и
// форматирование одной строки ежедневной сводки для одного участника.
//
// Структура полей (data.lifetime.all.properties.{kills,deaths,wins,
// kdRatio}) взята из независимого, задокументированного примера
// реального использования этого же API (gist.github.com/Membear --
// IRC-бот 2020 года, напрямую показывающий пути $json(...,data,lifetime,
// all,properties,kills).value и т.п.), а НЕ из архивного npm-пакета
// (тот возвращает тело ответа как непрозрачный объект, не разбирая его
// поля вообще). "lifetime" означает статистику за всё время (общий
// прогресс), а не только за прошедшие сутки -- у самого Activision API
// нет отдельного "за вчера" без дополнительного запроса истории матчей,
// который здесь не реализован (см. обсуждение с владельцем).

/** То, что реально интересует в ответе -- НЕ весь объект Activision
 * целиком (у него десятков незадокументированных дополнительных полей),
 * только то, что уйдёт в сводку. undefined для любого поля, которое
 * Activision не прислал/прислал не числом -- тогда соответствующая
 * часть строки сводки просто опускается, а не подставляется как 0 или
 * "н/д", что выглядело бы как реальное значение. */
export interface ExtractedLifetimeStats {
  kills: number | undefined;
  deaths: number | undefined;
  wins: number | undefined;
  kdRatio: number | undefined;
}

/** Достаёт data.lifetime.all.properties.{kills,deaths,wins,kdRatio} из
 * сырого, ещё не типизированного JSON-ответа (см. fetchWarzoneProfile в
 * cod-client.ts). Узко проверяет форму на каждом шаге вместо одного
 * слепого каста -- отсутствующее/не-числовое поле просто становится
 * undefined в результате, а не бросает исключение: неполные данные от
 * Activision (например, только часть полей) не должны ронять всю
 * сводку, только эту одну строку в ней. */
export function extractLifetimeStats(raw: unknown): ExtractedLifetimeStats {
  const properties = digNumberRecord(raw, ["data", "lifetime", "all", "properties"]);
  return {
    kills: properties?.kills,
    deaths: properties?.deaths,
    wins: properties?.wins,
    kdRatio: properties?.kdRatio,
  };
}

/** Идёт по вложенным объектам по заданному пути ключей и, если в конце
 * действительно объект, возвращает его с полями, которые являются
 * числами, оставляя прочие как undefined -- вместо того чтобы слепо
 * кастовать unknown на каждом шаге. */
function digNumberRecord(value: unknown, path: readonly string[]): Partial<Record<string, number>> | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "object" || current === null) return null;
  const record = current as Record<string, unknown>;
  const result: Partial<Record<string, number>> = {};
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) result[key] = v;
  }
  return result;
}

/** Формат одного числа для сводки -- целые без десятичных (киллы,
 * победы), K/D округляется до 2 знаков (как обычно и показывают сами
 * игры/трекеры). */
function formatNumber(value: number, decimals: 0 | 2): string {
  return value.toFixed(decimals);
}

/** Одна строка сводки для одного участника с УСПЕШНО полученной
 * статистикой -- "• Имя (тег): килл 123, побед 4, K/D 1.25". Любое из
 * четырёх полей, которое Activision не прислал, просто опускается из
 * строки (см. extractLifetimeStats выше), а не превращается в "0" или
 * "н/д". Если НИ ОДНО поле не пришло, явно говорит об этом, а не
 * показывает пустую бессмысленную строку с одним именем. */
export function formatMemberStatsLine(displayName: string, activisionTag: string, stats: ExtractedLifetimeStats): string {
  const parts: string[] = [];
  if (stats.kills !== undefined) parts.push(`килл ${formatNumber(stats.kills, 0)}`);
  if (stats.deaths !== undefined) parts.push(`смертей ${formatNumber(stats.deaths, 0)}`);
  if (stats.wins !== undefined) parts.push(`побед ${formatNumber(stats.wins, 0)}`);
  if (stats.kdRatio !== undefined) parts.push(`K/D ${formatNumber(stats.kdRatio, 2)}`);

  const statsText = parts.length > 0 ? parts.join(", ") : "Activision не прислал ни одного из ожидаемых полей статистики";
  return `• ${displayName} (${activisionTag}): ${statsText}`;
}

/** Одна строка для участника, для которого статистику получить НЕ
 * удалось -- формулировка зависит от причины (см. CodApiFailureReason в
 * cod-client.ts), чтобы это было понятно не только владельцу бота, но и
 * самому участнику, читающему сводку в группе: "профиль закрыт" требует
 * от него конкретного действия (открыть видимость в Account Linking), а
 * "сессия бота не работает" -- это не его забота, а владельца. */
export function formatMemberFailureLine(
  displayName: string,
  activisionTag: string,
  reason: "unauthenticated" | "not_found_or_unknown_title" | "profile_private" | "unexpected_response",
): string {
  const explanation: Record<typeof reason, string> = {
    unauthenticated: "сессия бота сейчас не работает (нужно обновить Activision-cookie в /settings)",
    not_found_or_unknown_title: "тег не найден или код игры не распознан Activision",
    profile_private: "профиль закрыт — включите видимость статистики в Account Linking на callofduty.com",
    unexpected_response: "Activision ответил неожиданно",
  };
  return `• ${displayName} (${activisionTag}): не удалось получить статистику — ${explanation[reason]}`;
}

/** Собирает итоговый текст сообщения сводки из уже готовых строк по
 * каждому участнику -- просто склеивает с заголовком, никакой другой
 * логики (сортировки/агрегации) здесь нет: не запрашивалось. */
export function formatDailySummaryMessage(channelTitle: string, memberLines: readonly string[]): string {
  return `🎮 Ежедневная сводка по играм — ${channelTitle}\n\n${memberLines.join("\n")}`;
}
