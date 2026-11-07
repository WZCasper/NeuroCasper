// Получение рабочей CodSession (см. cod-client.ts) из служебной
// activision_session (единственная строка в БД, см. schema.sql).
//
// ЧЕСТНО: владелец и Claude изначально договаривались о схеме
// "email+пароль первым, вручную добытая cookie как fallback". По итогам
// дальнейшего разбора реальной reference-реализации выяснилось, что для
// ПУТИ, который нужен владельцу (my.callofduty.com, статистика Warzone),
// программного входа по email+паролю не существует вообще — ни в каком
// виде. Единственный способ получить рабочую сессию для ЭТОГО пути —
// вручную добытая ACT_SSO_COOKIE. Поэтому resolveCodSession ниже не
// "пробует пароль, потом cookie" (пробовать нечего — для пароля здесь
// нет рабочего механизма), а напрямую берёт cookie_value — email/password
// в activision_session всё равно хранятся (на случай, если в будущем
// появится отдельная интеграция через telescope-путь, который ДЕЙСТВИТЕЛЬНО
// поддерживает пароль, но для ДРУГОГО набора игр — Warzone2/MW2/MW3,
// не классический Warzone), но текущий код их не использует.

import type { ActivisionSessionRow } from "../types.js";
import type { CodSession } from "./cod-client.js";

/** Причина, по которой рабочую сессию получить не удалось — чтобы
 * вызывающий код (scheduled-cod-summary.ts) мог сообщить владельцу
 * ПОНЯТНО, что именно нужно сделать, а не просто "что-то не работает". */
export type CodSessionFailureReason =
  // activision_session вообще ни разу не настроена (владелец ещё не
  // создал служебный Activision-аккаунт/не положил cookie).
  | "not_configured"
  // cookie_value пуста/не задана, хотя строка activision_session
  // существует (например, владелец сохранил только email/пароль,
  // не понимая, что для текущего пути нужна именно cookie).
  | "cookie_missing";

export interface CodSessionResult {
  ok: true;
  session: CodSession;
}

export interface CodSessionFailure {
  ok: false;
  reason: CodSessionFailureReason;
}

/** Строит CodSession из того, что реально сохранено в activision_session
 * -- на сегодняшний момент это ВСЕГДА cookie_value, см. комментарий файла
 * выше. Чистая функция (без сети, без БД) -- принимает уже прочитанную
 * строку, а не сама её читает, чтобы оставаться тестируемой без мока БД;
 * вызывающий код сам делает getActivisionSession(env) и передаёт сюда
 * результат. */
export function resolveCodSession(row: ActivisionSessionRow | null): CodSessionResult | CodSessionFailure {
  if (!row) return { ok: false, reason: "not_configured" };
  const cookie = row.cookie_value?.trim();
  if (!cookie) return { ok: false, reason: "cookie_missing" };
  return { ok: true, session: { ssoToken: cookie } };
}
