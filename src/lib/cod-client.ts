// Клиент неофициального, недокументированного Activision/Call of Duty
// stats API (my.callofduty.com/api/papi-client) -- построен напрямую по
// паттернам из единственной заслуживающей доверия reference-реализации,
// npm `call-of-duty-api` v4.1.0 (архивирована/не поддерживается с
// 2024-10-13), а не как зависимость от неё: сам пакет не содержит кода
// для игр 2025-2026 годов, значит единственный разумный путь -- повторить
// его заголовки/URL-паттерн напрямую, с настраиваемым кодом игры (см.
// DEFAULT_COD_TITLE_CODE ниже).
//
// ЧЕСТНО О НЕОПРЕДЕЛЁННОСТИ (см. обсуждение с владельцем бота): точный
// код игры (`title`) для Black Ops 7 и Modern Warfare 4 НЕ подтверждён
// ни в одном открытом источнике на момент написания этого файла (конец
// 2026) -- только исторические коды для игр 2017-2020 годов
// задокументированы где-либо (mw, mw2, cw, vg, bo3, bo4, wwii, iw).
// DEFAULT_COD_TITLE_CODE ниже -- разумное ПРЕДПОЛОЖЕНИЕ по аналогии с уже
// подтверждённым паттерном именования (bo3 → bo4 → по аналогии bo7), а
// НЕ подтверждённый рабочий код. channels.cod_title_code позволяет
// владельцу переопределить его в /settings без единой правки в этом
// файле, когда подтверждённый код станет известен (методом подбора после
// деплоя, либо когда кто-то в сообществе его опубликует).
//
// Activision НИКОГДА не выдаёт официальный доступ к этому API хобби-ботам
// -- он может быть заблокирован, изменён или отключён в любой момент без
// предупреждения. Этот файл не пытается это скрыть: каждая ошибка от
// Activision передаётся наверх как есть (см. CodApiError), а не
// проглатывается и не заменяется выдуманными данными.

/** Код игры для подстановки в URL вида
 * .../title/{titleCode}/platform/{platform}/gamer/{tag}/... --
 * см. комментарий файла выше: это ПРЕДПОЛОЖЕНИЕ, не подтверждённый факт.
 * channels.cod_title_code переопределяет это значение для конкретного
 * чата -- см. resolveCodTitleCode ниже. */
export const DEFAULT_COD_TITLE_CODE = "bo7";

/** Платформа тега -- "acti" для классического Activision ID (формат
 * "Имя#1234567", именно то, что владелец бота привёл как пример --
 * "亗 Casper#7378333") в отличие от "psn"/"xbl"/"battle"/"uno" для
 * привязанных игровых аккаунтов других платформ. Жёстко задано здесь,
 * а не настраивается для каждого участника отдельно -- если выяснится,
 * что участники используют другие платформы, это нужно будет
 * параметризовать позже, когда появится реальная необходимость. */
const TAG_PLATFORM = "acti";

const BASE_URL = "https://my.callofduty.com";
const API_PATH = "/api/papi-client";

// Это ТОЧНАЯ копия user-agent/заголовков из call-of-duty-api v4.1.0
// (см. обсуждение с владельцем выше) -- Activision проверяет их при
// принятии решения, обслуживать ли запрос, и это единственный
// подтверждённый рабочий набор, а не что-то, что можно безопасно
// упростить или угадать заново.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36";

/** Что известно о причине отказа Activision -- различается, чтобы
 * вызывающий код (src/scheduled-cod-summary.ts) мог отличить "эта
 * cookie протухла, нужно попросить владельца обновить её" от "Activision
 * вообще не считает title/эндпойнт существующим" от "сам игрок ещё не
 * сделал профиль публичным" -- это РАЗНЫЕ проблемы с разными действиями
 * в ответ, и схлопывать их в одно сообщение об ошибке было бы менее
 * полезно, чем разделить. */
export type CodApiFailureReason =
  // HTTP 401/403 -- cookie протухла/недействительна, или оба способа
  // входа (email+пароль и cookie-fallback) не дали рабочей сессии.
  | "unauthenticated"
  // HTTP 404, или тело ответа не похоже на ожидаемую структуру
  // "обёртка со статистикой" -- либо сам тег не существует, либо
  // (что вероятнее при неподтверждённом title) сам code игры не
  // распознаётся Activision как действующий title.
  | "not_found_or_unknown_title"
  // Профиль этого тега приватный -- Activision ответил, но явно
  // отказал в данных, потому что сам игрок не включил видимость
  // статистики для посторонних аккаунтов в Account Linking.
  | "profile_private"
  // Activision вернул HTTP-ошибку, не подходящую ни под одну из
  // категорий выше (технические сбои на их стороне, неожиданный формат
  // ответа и т.д.) -- httpStatus/rawBody несут детали для диагностики.
  | "unexpected_response";

/** Брошено при любом отказе Activision -- никогда не проглатывается
 * молча нигде в этом файле. Сам текст сообщения НЕ показывается
 * участникам группы напрямую (см. formatCodSummaryLine в
 * cod-summary-formatting.ts): это для логов/диагностики владельца. */
export class CodApiError extends Error {
  readonly reason: CodApiFailureReason;
  readonly httpStatus: number | null;
  readonly rawBody: string | null;

  constructor(reason: CodApiFailureReason, message: string, httpStatus: number | null, rawBody: string | null) {
    super(message);
    this.name = "CodApiError";
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.rawBody = rawBody;
  }
}

/** Одна рабочая сессия Activision -- либо собранная из ssoToken (ручная
 * cookie), либо (в будущем, для telescope-пути) из email+пароля. Чистый
 * объект данных, без побочных эффектов -- buildAuthHeaders ниже строит из
 * него реальные HTTP-заголовки. */
export interface CodSession {
  ssoToken: string;
}

/** Собирает заголовки авторизации из ssoToken -- ТОЧНАЯ копия того, как
 * это делает call-of-duty-api v4.1.0's login(ssoToken): состав cookie
 * собирается вручную из нескольких полей (включая фейковые
 * ACT_SSO_EVENT/ssoDevId -- именно так делает reference-реализация,
 * Activision, по всей видимости, не проверяет их подлинность строго, а
 * лишь ожидает их присутствия), а не просто "cookie: ACT_SSO_COOKIE=...".
 * Чистая функция -- без сети, тестируется без мока fetch. */
export function buildAuthHeaders(session: CodSession): Record<string, string> {
  const fakeXsrf = "D1D3F60C0A2BF26498E345D77DD4F85A";
  return {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    atkn: session.ssoToken,
    "atvi-auth": session.ssoToken,
    "x-requested-with": "XMLHttpRequest",
    cookie:
      `new_SiteId=cod;ACT_SSO_LOCALE=en_US;country=US;` +
      `ACT_SSO_COOKIE=${session.ssoToken};XSRF-TOKEN=${fakeXsrf};API_CSRF_TOKEN=${fakeXsrf};` +
      `ACT_SSO_EVENT="LOGIN_SUCCESS:${Date.now()}";comid=cod;` +
      `ssoDevId=63025d09c69f47dfa2b8d5520b5b73e4;tfa_enrollment_seen=true;gtm.custom.bot.flag=human;`,
  };
}

/** Какой title-код реально использовать для этого чата: явно заданный
 * channels.cod_title_code, иначе DEFAULT_COD_TITLE_CODE. Чистая функция
 * по тому же принципу, что и у остальных resolve*-функций проекта (см.
 * resolveAntilinkWhitelist/resolveUrlBlacklist в antilink.ts): владелец
 * задаёт override, отсутствие override -- не ошибка, а штатный путь на
 * встроенное значение. */
export function resolveCodTitleCode(override: string | null): string {
  const trimmed = override?.trim();
  return trimmed ? trimmed : DEFAULT_COD_TITLE_CODE;
}

/** URL запроса сводной статистики одного игрока по Warzone (mode=wz) --
 * именно тот путь, что просил владелец ("Warzone / ... / Warzone").
 * Чистая функция (строит строку, не делает запрос) -- так URL можно
 * протестировать и свериться с документированными примерами без сети. */
export function buildWarzoneProfileUrl(titleCode: string, activisionTag: string): string {
  // encodeURIComponent, а не просто подстановка тега в URL -- тег почти
  // всегда содержит "#" (разделитель числового суффикса Activision ID,
  // как в примере владельца "亗 Casper#7378333"), который без
  // кодирования либо обрывает URL на фрагменте, либо (после кодирования
  // Activision-ом на их стороне как %23, задокументированного в
  // найденных примерах выше) не совпадёт с тем, что ожидает их API.
  const encodedTag = encodeURIComponent(activisionTag);
  return `${BASE_URL}${API_PATH}/stats/cod/v1/title/${titleCode}/platform/${TAG_PLATFORM}/gamer/${encodedTag}/profile/type/wz`;
}

/** Делает реальный сетевой запрос и либо возвращает сырой разобранный
 * JSON-ответ Activision, либо бросает CodApiError с конкретной причиной
 * отказа. Единственное место в этом файле, которое трогает сеть --
 * остальное (buildAuthHeaders/buildWarzoneProfileUrl/resolveCodTitleCode)
 * чистые функции, тестируемые без мока fetch. */
export async function fetchWarzoneProfile(
  session: CodSession,
  titleCode: string,
  activisionTag: string,
): Promise<unknown> {
  const url = buildWarzoneProfileUrl(titleCode, activisionTag);
  const response = await fetch(url, { headers: buildAuthHeaders(session) });

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => null);
    throw new CodApiError("unauthenticated", `Activision отклонил сессию (HTTP ${response.status})`, response.status, body);
  }
  if (response.status === 404) {
    const body = await response.text().catch(() => null);
    throw new CodApiError(
      "not_found_or_unknown_title",
      `Activision вернул 404 — либо тег «${activisionTag}» не существует, либо title «${titleCode}» не распознан`,
      response.status,
      body,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => null);
    throw new CodApiError("unexpected_response", `Activision вернул неожиданный статус HTTP ${response.status}`, response.status, body);
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CodApiError("unexpected_response", "Ответ Activision не является JSON", response.status, body);
  }

  // Документированный формат папки-обёртки (см. примеры из
  // jakejrichards/cod-api и call-of-duty-api): { status: "success"|...,
  // data: {...} }. status, отличный от "success", обычно означает
  // приватный профиль -- Activision при этом всё равно отвечает HTTP 200,
  // так что это нужно различать отдельно от HTTP-статуса выше.
  if (isPapiEnvelope(parsed) && parsed.status !== "success") {
    throw new CodApiError(
      "profile_private",
      `Activision ответил status="${parsed.status}" — вероятно, профиль «${activisionTag}» не сделан публичным`,
      response.status,
      body,
    );
  }

  return parsed;
}

/** Проверяет, что значение похоже на документированную обёртку
 * { status, data } -- узкая проверка перед тем, как читать .status,
 * а не слепой каст unknown в предполагаемую форму. */
function isPapiEnvelope(value: unknown): value is { status: unknown; data?: unknown } {
  return typeof value === "object" && value !== null && "status" in value;
}
