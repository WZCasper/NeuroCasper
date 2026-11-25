/**
 * Telegram-усернеймы двух людей, которым (и только им) видна и доступна
 * кнопка "📢 РЕКЛАМА" — рассылка рекламных постов по всем группам бота или
 * в личку их администраторам. Это НЕ привязано к владению каналом
 * (owner_user_id в таблице channels) — отдельный, не связанный ни с одним
 * конкретным чатом список людей, жёстко заданный в коде по прямой просьбе
 * заказчика бота. Хранится в lowercase без ведущей "@" — сравнение
 * регистронезависимое, как и у самого Telegram (@Alice и @alice — один и
 * тот же аккаунт).
 */
const SUPER_ADMIN_USERNAMES: ReadonlySet<string> = new Set(["wz_casper", "casper7722026"]);

/**
 * Правда, если этот Telegram-усернейм (с ведущей "@" или без неё, в любом
 * регистре) принадлежит одному из двух суперадминов выше. `username` —
 * именно то, что Telegram присылает в поле `username` апдейта
 * (`ctx.from?.username`); у человека вообще может не быть усернейма
 * (Telegram это допускает) — тогда здесь всегда false, доступа нет ни при
 * каких условиях.
 */
export function isSuperAdminUsername(username: string | undefined | null): boolean {
  if (!username) return false;
  const normalized = username.replace(/^@/, "").toLowerCase();
  return SUPER_ADMIN_USERNAMES.has(normalized);
}
