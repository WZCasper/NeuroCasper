import { Bot, Context, InlineKeyboard } from "grammy";
import {
  createChannel,
  createExtraLink,
  createKickOAuthState,
  createSocialAccount,
  createStreamer,
  deleteExtraLink,
  getChannelById,
  getChannelByOwnerAndChatId,
  getStreamerById,
  listChannelsByOwner,
  listExtraLinksByStreamer,
  listSocialAccountsByStreamer,
  listStreamersByChannel,
  setSession,
  toggleChannelFlag,
  updateChannelTemplate,
} from "../db.js";
import { buildAuthorizationUrl, generatePkcePair } from "../lib/kick.js";
import { DEFAULT_TEMPLATE } from "../lib/message-templates.js";
import { removeSocialAccount, removeStreamer } from "../lib/removal.js";
import { IDLE_SESSION } from "../types.js";
import type { ChannelRow, Env, Platform, SessionState, StreamerRow, UserRow } from "../types.js";

export interface BotContext extends Context {
  dbUser: UserRow;
  session: SessionState;
}

const ALL_PLATFORMS: Platform[] = ["youtube", "tiktok", "kick"];
const PLATFORM_DISPLAY: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", kick: "Kick" };

export function registerHandlers(bot: Bot<BotContext>, env: Env): void {
  bot.command("start", async (ctx) => {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply(
      "NeuroCasper следит за стримерами на YouTube/TikTok/Kick и присылает уведомление «в эфире» или «новое видео» " +
        "в ваш Telegram-канал или группу — с кнопкой на каждую платформу, плюс любые дополнительные ссылки " +
        "(Twitch, Discord и т.д.), которые показываются в каждом уведомлении независимо от того, какая " +
        "платформа его вызвала.\n\n" +
        "Настройка:\n" +
        "1) Добавьте меня админом (с правом «закреплять сообщения») в канал или группу.\n" +
        "2) Зарегистрируйте её:\n" +
        "   • Группа: отправьте /add_channel прямо в группе.\n" +
        "   • Канал: перешлите мне сюда, в личку, любой пост из канала.\n" +
        "3) Вернитесь в эту личку и отправьте /add_social, чтобы привязать стримера.\n" +
        "4) Команда /settings в любой момент — изменить текст уведомления или поведение закрепления.\n\n" +
        "Если один и тот же стример одновременно в эфире на нескольких отслеживаемых платформах, я объединяю " +
        "это в одно сообщение с кнопкой на каждую платформу вместо дублей.",
    );
  });

  bot.command("add_channel", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === "private") {
      await ctx.reply(
        "Отправьте /add_channel прямо в группе, куда должны приходить уведомления — а для канала перешлите мне сюда любой пост из него.",
      );
      return;
    }
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await ctx.reply("Это работает только в группах/супергруппах. Для каналов перешлите мне пост в личку.");
      return;
    }
    if (!ctx.from) return;

    const botMember = await ctx.getChatMember(ctx.me.id).catch(() => null);
    if (!botMember || botMember.status !== "administrator") {
      await ctx.reply(
        "Сначала сделайте меня админом здесь (права на публикацию и закрепление сообщений), потом снова отправьте /add_channel.",
      );
      return;
    }

    const userMember = await ctx.getChatMember(ctx.from.id).catch(() => null);
    if (!userMember || (userMember.status !== "creator" && userMember.status !== "administrator")) {
      await ctx.reply("Зарегистрировать эту группу может только её админ.");
      return;
    }

    const existing = await getChannelByOwnerAndChatId(env, ctx.dbUser.id, chat.id);
    if (existing) {
      await ctx.reply("Эта группа уже зарегистрирована. Напишите мне в личку /add_social, чтобы привязать стримера.");
      return;
    }

    await createChannel(env, ctx.dbUser.id, chat.id, chat.title);
    await ctx.reply("✅ Зарегистрировано! Напишите мне в личку /add_social, чтобы привязать стримера YouTube/TikTok.");
  });

  bot.command("add_social", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Напишите мне в личные сообщения, чтобы добавить стримера — группы/каналы только для уведомлений.");
      return;
    }
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    if (channels.length === 0) {
      await ctx.reply("Вы ещё не зарегистрировали канал или группу — см. /start.");
      return;
    }
    const only = channels.length === 1 ? channels[0] : undefined;
    if (only) await promptStreamerChoice(ctx, env, only, false);
    else await promptChannelChoice(ctx, channels, "soc");
  });

  bot.command("settings", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Напишите мне в личные сообщения, чтобы изменить настройки.");
      return;
    }
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    if (channels.length === 0) {
      await ctx.reply("Вы ещё не зарегистрировали канал или группу — см. /start.");
      return;
    }
    await promptChannelChoice(ctx, channels, "set");
  });

  bot.on("callback_query:data", async (ctx) => {
    const [scope, ...rest] = ctx.callbackQuery.data.split(":");
    try {
      if (scope === "soc") await handleAddSocialCallback(ctx, env, rest);
      else if (scope === "set") await handleSettingsCallback(ctx, env, rest);
    } finally {
      await ctx.answerCallbackQuery().catch(() => undefined);
    }
  });

  // Catch-all for private-chat messages: forwarded channel posts (channel
  // registration) and free-text replies for the multi-step flows above.
  bot.on("message", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    if (ctx.message.forward_origin?.type === "channel") {
      await registerChannelFromForward(ctx, env);
      return;
    }

    const session = ctx.session;
    if (session.step === "awaiting_streamer_name") {
      await handleStreamerNameInput(ctx, env, session.data);
    } else if (session.step === "awaiting_social_username") {
      await handleSocialUsernameInput(ctx, env, session.data);
    } else if (session.step === "awaiting_link_label") {
      await handleLinkLabelInput(ctx, env, session.data);
    } else if (session.step === "awaiting_link_url") {
      await handleLinkUrlInput(ctx, env, session.data);
    } else if (session.step === "awaiting_template") {
      await handleTemplateInput(ctx, env, session.data);
    }
  });
}

// ---------------------------------------------------------------------------
// Регистрация канала через пересланный пост (для broadcast-каналов)
// ---------------------------------------------------------------------------

async function registerChannelFromForward(ctx: BotContext, env: Env): Promise<void> {
  const origin = ctx.message?.forward_origin;
  if (!origin || origin.type !== "channel" || !ctx.from) return;
  const channelChat = origin.chat;

  const botMember = await ctx.api.getChatMember(channelChat.id, ctx.me.id).catch(() => null);
  if (!botMember || botMember.status !== "administrator") {
    await ctx.reply(
      "Я ещё не админ этого канала. Добавьте меня админом (права на публикацию и закрепление), потом перешлите пост ещё раз.",
    );
    return;
  }

  const userMember = await ctx.api.getChatMember(channelChat.id, ctx.from.id).catch(() => null);
  if (!userMember || (userMember.status !== "creator" && userMember.status !== "administrator")) {
    await ctx.reply("Зарегистрировать этот канал может только его админ.");
    return;
  }

  const existing = await getChannelByOwnerAndChatId(env, ctx.dbUser.id, channelChat.id);
  if (existing) {
    await ctx.reply("Этот канал уже зарегистрирован. Отправьте /add_social, чтобы привязать стримера.");
    return;
  }

  await createChannel(env, ctx.dbUser.id, channelChat.id, channelChat.title);
  await ctx.reply(
    `✅ «${channelChat.title}» зарегистрирован! Отправьте /add_social, чтобы привязать стримера YouTube/TikTok.`,
  );
}

// ---------------------------------------------------------------------------
// /add_social: канал -> стример (новый или существующий) -> платформа/ссылка -> значение
// ---------------------------------------------------------------------------

async function promptChannelChoice(ctx: BotContext, channels: ChannelRow[], prefix: "soc" | "set"): Promise<void> {
  const kb = new InlineKeyboard();
  for (const ch of channels) {
    kb.text(ch.title ?? String(ch.telegram_chat_id), `${prefix}:ch:${ch.id}`).row();
  }
  await ctx.reply("Какой канал/группа?", { reply_markup: kb });
}

async function promptStreamerChoice(
  ctx: BotContext,
  env: Env,
  channel: ChannelRow,
  edit: boolean,
): Promise<void> {
  const streamers = await listStreamersByChannel(env, channel.id);
  const kb = new InlineKeyboard();
  for (const s of streamers) kb.text(s.display_name, `soc:str:${s.id}`).row();
  kb.text("➕ Новый стример", `soc:newstr:${channel.id}`).row();
  const text = `Стример для «${channel.title ?? channel.telegram_chat_id}»:`;
  if (edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
}

/** Показывает выбор отслеживаемых платформ (YouTube/TikTok, кроме уже
 * привязанных) плюс всегда доступный вариант «добавить ссылку» для всего,
 * что не отслеживается по-настоящему (Twitch, Discord, ...) — см. комментарий
 * к таблице extra_links в schema.sql про то, почему Twitch там, а не в
 * настоящем мониторинге. */
async function promptPlatformChoice(
  ctx: BotContext,
  env: Env,
  streamerId: number,
  edit: boolean,
): Promise<void> {
  const existing = await listSocialAccountsByStreamer(env, streamerId);
  const taken = new Set(existing.map((a) => a.platform));
  const remaining = ALL_PLATFORMS.filter((p) => !taken.has(p));

  const kb = new InlineKeyboard();
  for (const p of remaining) kb.text(PLATFORM_DISPLAY[p], `soc:pl:${streamerId}:${p}`).row();
  kb.text("\u{1F517} Добавить ссылку (Twitch, Discord, ...)", `soc:link:${streamerId}`).row();

  const text =
    remaining.length > 0
      ? "Какая платформа, или добавить ссылку?"
      : "Добавить ссылку (все отслеживаемые платформы уже привязаны):";
  if (edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
}

/** Starts Kick's OAuth flow: unlike YouTube/TikTok (a public username is
 * enough), Kick requires the streamer themself to approve this bot via
 * Kick's own login, since events:subscribe is authorized per-channel. This
 * sends an authorization link the streamer opens in their own browser --
 * createSocialAccount for their Kick account only happens once they finish
 * that and Kick redirects back to /kick/oauth/callback (src/index.ts). */
async function promptKickAuthorization(ctx: BotContext, env: Env, streamerId: number): Promise<void> {
  if (!env.KICK_CLIENT_ID || !env.WORKER_URL) {
    await ctx.editMessageText(
      "Интеграция с Kick не настроена на сервере (нет KICK_CLIENT_ID или WORKER_URL). " +
        "Обратитесь к администратору бота.",
    );
    return;
  }

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = crypto.randomUUID();
  await createKickOAuthState(env, state, codeVerifier, streamerId, ctx.dbUser.id);

  const url = buildAuthorizationUrl({
    clientId: env.KICK_CLIENT_ID,
    redirectUri: `${env.WORKER_URL}/kick/oauth/callback`,
    state,
    codeChallenge,
  });

  const kb = new InlineKeyboard().url("\u{1F7E2} Авторизовать на Kick", url).row();
  kb.text("\u{2B05} Назад", `soc:str:${streamerId}`).row();
  await ctx.editMessageText(
    "Откройте ссылку и разрешите доступ своим аккаунтом Kick — стример должен сделать это сам, " +
      "это подтверждает его канал. Ссылка действительна 10 минут.",
    { reply_markup: kb },
  );
}

async function handleAddSocialCallback(ctx: BotContext, env: Env, rest: string[]): Promise<void> {
  const action = rest[0];

  if (action === "ch" && rest[1]) {
    const channel = await getChannelById(env, Number(rest[1]));
    if (channel) await promptStreamerChoice(ctx, env, channel, true);
    return;
  }

  if (action === "newstr" && rest[1]) {
    const channelId = Number(rest[1]);
    await setSession(env, ctx.dbUser.id, { step: "awaiting_streamer_name", data: { channel_id: channelId } });
    await ctx.editMessageText('Как зовут этого стримера? (будет показано в уведомлениях, например «Алекс»)');
    return;
  }

  if (action === "str" && rest[1]) {
    await promptPlatformChoice(ctx, env, Number(rest[1]), true);
    return;
  }

  if (action === "pl" && rest[1] && rest[2]) {
    const streamerId = Number(rest[1]);
    const platform = rest[2] as Platform;

    if (platform === "kick") {
      await promptKickAuthorization(ctx, env, streamerId);
      return;
    }

    await setSession(env, ctx.dbUser.id, {
      step: "awaiting_social_username",
      data: { streamer_id: streamerId, platform },
    });
    const hint =
      platform === "youtube"
        ? "Отправьте ID YouTube-канала (начинается с UC…) или @хэндл."
        : "Отправьте юзернейм TikTok (без @).";
    await ctx.editMessageText(hint);
    return;
  }

  if (action === "link" && rest[1]) {
    const streamerId = Number(rest[1]);
    await setSession(env, ctx.dbUser.id, { step: "awaiting_link_label", data: { streamer_id: streamerId } });
    await ctx.editMessageText('Какая надпись будет на кнопке? (например «Twitch», «Discord»)');
  }
}

async function handleStreamerNameInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const name = ctx.message?.text?.trim();
  if (!name) return;
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const streamer = await createStreamer(env, data.channel_id, name);
  await promptPlatformChoice(ctx, env, streamer.id, false);
}

async function handleSocialUsernameInput(
  ctx: BotContext,
  env: Env,
  data: { streamer_id: number; platform: Platform },
): Promise<void> {
  const raw = ctx.message?.text?.trim();
  if (!raw) return;
  const username = raw.replace(/^@/, "");

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);

  // Kick never reaches this function -- selecting it in promptPlatformChoice
  // goes straight to promptKickAuthorization's OAuth flow instead of this
  // username-based session step (see handleAddSocialCallback's "pl" case).
  // Written as an exhaustive check rather than an `if/else` that silently
  // treated "not youtube" as "must be tiktok", so a future platform added
  // here without updating this function fails loudly instead of being
  // misrouted to the wrong add-account logic.
  if (data.platform === "youtube") await addYoutubeSocial(ctx, env, data.streamer_id, username);
  else if (data.platform === "tiktok") await addTiktokSocial(ctx, env, data.streamer_id, username);
  else console.error(`handleSocialUsernameInput: unexpected platform "${data.platform}"`);
}

async function addYoutubeSocial(ctx: BotContext, env: Env, streamerId: number, input: string): Promise<void> {
  let channelYtId = input;

  if (!/^UC[\w-]{22}$/.test(input)) {
    await ctx.reply("Определяю канал по хэндлу…");
    try {
      channelYtId = await resolveYoutubeChannelId(input);
    } catch (err) {
      console.error("YouTube handle resolution failed", err);
      await ctx.reply(
        "Не удалось автоматически определить канал по хэндлу. Откройте канал на youtube.com, скопируйте ID из адреса (начинается с UC…) и отправьте его.",
      );
      return;
    }
  }

  await createSocialAccount(env, streamerId, "youtube", input, channelYtId);
  await ctx.reply(
    `✅ YouTube-канал привязан (ID: ${channelYtId}). Проверяется примерно раз в 5 минут.`,
  );
}

/** Best-effort: у YouTube нет бесплатного публичного способа получить
 * channelId по хэндлу, поэтому здесь парсится HTML страницы канала. Может
 * сломаться, если YouTube изменит вёрстку страницы — надёжный вариант —
 * пользователь сам вставляет ID канала (начинается с UC…). */
async function resolveYoutubeChannelId(handle: string): Promise<string> {
  const cleanHandle = handle.replace(/^@/, "");
  const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(cleanHandle)}`);
  if (!res.ok) throw new Error(`YouTube page fetch failed: ${res.status}`);
  const html = await res.text();
  const match = html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!match || !match[1]) throw new Error("channelId not found in page");
  return match[1];
}

async function addTiktokSocial(ctx: BotContext, env: Env, streamerId: number, username: string): Promise<void> {
  await createSocialAccount(env, streamerId, "tiktok", username, null);
  await ctx.reply(
    `✅ TikTok/@${username} привязан. Учтите: у TikTok нет публичного API статуса эфира, поэтому проверка идёт через best-effort разбор страницы, который может сломаться при изменении сайта TikTok — считайте это менее надёжным, чем YouTube.`,
  );
}

async function handleLinkLabelInput(ctx: BotContext, env: Env, data: { streamer_id: number }): Promise<void> {
  const label = ctx.message?.text?.trim();
  if (!label) return;
  await setSession(env, ctx.dbUser.id, { step: "awaiting_link_url", data: { streamer_id: data.streamer_id, label } });
  await ctx.reply(`А теперь ссылку для «${label}»?`);
}

async function handleLinkUrlInput(
  ctx: BotContext,
  env: Env,
  data: { streamer_id: number; label: string },
): Promise<void> {
  const raw = ctx.message?.text?.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  await createExtraLink(env, data.streamer_id, data.label, url);
  await ctx.reply(
    `✅ Ссылка «${data.label}» привязана — будет показываться кнопкой в каждом уведомлении этого стримера, независимо от того, какая платформа его вызвала.`,
  );
}

// ---------------------------------------------------------------------------
// /settings
// ---------------------------------------------------------------------------

async function handleSettingsCallback(ctx: BotContext, env: Env, rest: string[]): Promise<void> {
  const action = rest[0];

  if (action === "ch" && rest[1]) {
    const channel = await getChannelById(env, Number(rest[1]));
    if (channel) await renderChannelSettings(ctx, env, channel);
    return;
  }

  if (action === "pin" && rest[1]) {
    const channel = await toggleChannelFlag(env, Number(rest[1]), "auto_pin");
    if (channel) await renderChannelSettings(ctx, env, channel);
    return;
  }

  if (action === "unpin" && rest[1]) {
    const channel = await toggleChannelFlag(env, Number(rest[1]), "auto_unpin");
    if (channel) await renderChannelSettings(ctx, env, channel);
    return;
  }

  if (action === "tpl" && rest[1]) {
    const channelId = Number(rest[1]);
    await setSession(env, ctx.dbUser.id, { step: "awaiting_template", data: { channel_id: channelId } });
    await ctx.editMessageText(
      `Отправьте новый текст уведомления (показывается под заголовком «\u{1F534} {streamer} в эфире!»).\nПлейсхолдеры: {title} {game}\n\nПо умолчанию:\n${DEFAULT_TEMPLATE}`,
    );
    return;
  }

  if (action === "strs" && rest[1]) {
    const channel = await getChannelById(env, Number(rest[1]));
    if (channel) await renderStreamerList(ctx, env, channel);
    return;
  }

  if (action === "str" && rest[1]) {
    const streamer = await getStreamerById(env, Number(rest[1]));
    if (streamer) await renderStreamerDetail(ctx, env, streamer);
    return;
  }

  if (action === "ra" && rest[1] && rest[2]) {
    await renderConfirmRemoveAccount(ctx, env, Number(rest[1]), Number(rest[2]));
    return;
  }

  if (action === "rac" && rest[1] && rest[2]) {
    const streamerId = Number(rest[1]);
    const accountId = Number(rest[2]);
    const accounts = await listSocialAccountsByStreamer(env, streamerId);
    const account = accounts.find((a) => a.id === accountId);
    if (account) await removeSocialAccount(env, account);
    const streamer = await getStreamerById(env, streamerId);
    if (streamer) await renderStreamerDetail(ctx, env, streamer);
    return;
  }

  if (action === "rl" && rest[1] && rest[2]) {
    await renderConfirmRemoveLink(ctx, env, Number(rest[1]), Number(rest[2]));
    return;
  }

  if (action === "rlc" && rest[1] && rest[2]) {
    const streamerId = Number(rest[1]);
    await deleteExtraLink(env, Number(rest[2]));
    const streamer = await getStreamerById(env, streamerId);
    if (streamer) await renderStreamerDetail(ctx, env, streamer);
    return;
  }

  if (action === "rs" && rest[1]) {
    await renderConfirmRemoveStreamer(ctx, env, Number(rest[1]));
    return;
  }

  if (action === "rsc" && rest[1]) {
    const streamerId = Number(rest[1]);
    const streamer = await getStreamerById(env, streamerId);
    if (!streamer) return;
    const channelId = streamer.channel_id;
    await removeStreamer(env, streamerId);
    const channel = await getChannelById(env, channelId);
    if (channel) await renderStreamerList(ctx, env, channel);
    return;
  }

  if (action === "back") {
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    const kb = new InlineKeyboard();
    for (const ch of channels) kb.text(ch.title ?? String(ch.telegram_chat_id), `set:ch:${ch.id}`).row();
    await ctx.editMessageText("Какой канал/группа?", { reply_markup: kb });
  }
}

async function renderChannelSettings(ctx: BotContext, env: Env, channel: ChannelRow): Promise<void> {
  const streamers = await listStreamersByChannel(env, channel.id);
  const lines: string[] = [];
  for (const s of streamers) {
    const [accounts, links] = await Promise.all([
      listSocialAccountsByStreamer(env, s.id),
      listExtraLinksByStreamer(env, s.id),
    ]);
    const parts = [
      ...accounts.map((a) => PLATFORM_DISPLAY[a.platform]),
      ...links.map((l) => l.label),
    ];
    lines.push(`• ${s.display_name}: ${parts.length ? parts.join(", ") : "ничего не привязано"}`);
  }
  const list = lines.length ? lines.join("\n") : "(пока никого нет — добавьте через /add_social)";

  const text =
    `⚙️ ${channel.title ?? channel.telegram_chat_id}\n\n` +
    `Автозакрепление: ${channel.auto_pin ? "вкл" : "выкл"}\n` +
    `Автооткрепление: ${channel.auto_unpin ? "вкл" : "выкл"}\n\n` +
    `Стримеры:\n${list}\n\n` +
    `Текст уведомления:\n${channel.message_template}`;

  const kb = new InlineKeyboard()
    .text(channel.auto_pin ? "Выключить автозакрепление" : "Включить автозакрепление", `set:pin:${channel.id}`)
    .row()
    .text(channel.auto_unpin ? "Выключить автооткрепление" : "Включить автооткрепление", `set:unpin:${channel.id}`)
    .row()
    .text("Изменить текст уведомления", `set:tpl:${channel.id}`)
    .row()
    .text("👤 Управлять стримерами", `set:strs:${channel.id}`)
    .row()
    .text("⬅ Назад", "set:back");

  await ctx.editMessageText(text, { reply_markup: kb });
}

// ---------------------------------------------------------------------------
// Управление стримерами: список → карточка стримера → отвязка аккаунта/
// ссылки или удаление стримера целиком (с подтверждением на каждое
// разрушительное действие, чтобы случайное нажатие ничего не сносило).
// ---------------------------------------------------------------------------

async function renderStreamerList(ctx: BotContext, env: Env, channel: ChannelRow): Promise<void> {
  const streamers = await listStreamersByChannel(env, channel.id);

  const kb = new InlineKeyboard();
  for (const s of streamers) kb.text(`👤 ${s.display_name}`, `set:str:${s.id}`).row();
  kb.text("⬅ Назад", `set:ch:${channel.id}`);

  const text = streamers.length
    ? `👤 Стримеры канала «${channel.title ?? channel.telegram_chat_id}»\n\nВыберите, кого настроить или отвязать.`
    : `В этом канале пока нет ни одного стримера — добавьте через /add_social.`;

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function renderStreamerDetail(ctx: BotContext, env: Env, streamer: StreamerRow): Promise<void> {
  const [accounts, links] = await Promise.all([
    listSocialAccountsByStreamer(env, streamer.id),
    listExtraLinksByStreamer(env, streamer.id),
  ]);

  const accountLines = accounts.map((a) => `• ${PLATFORM_DISPLAY[a.platform]} (${a.platform_username})`);
  const linkLines = links.map((l) => `• ${l.label} — ${l.url}`);
  const text =
    `👤 ${streamer.display_name}\n\n` +
    `Отслеживаемые аккаунты:\n${accountLines.length ? accountLines.join("\n") : "нет"}\n\n` +
    `Доп. ссылки:\n${linkLines.length ? linkLines.join("\n") : "нет"}`;

  const kb = new InlineKeyboard();
  for (const a of accounts) {
    kb.text(`❌ Отвязать ${PLATFORM_DISPLAY[a.platform]}`, `set:ra:${streamer.id}:${a.id}`).row();
  }
  for (const l of links) {
    kb.text(`❌ Убрать «${l.label}»`, `set:rl:${streamer.id}:${l.id}`).row();
  }
  kb.text("🗑 Удалить стримера целиком", `set:rs:${streamer.id}`).row();
  kb.text("⬅ Назад", `set:strs:${streamer.channel_id}`);

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function renderConfirmRemoveAccount(
  ctx: BotContext,
  env: Env,
  streamerId: number,
  accountId: number,
): Promise<void> {
  const [streamer, accounts] = await Promise.all([
    getStreamerById(env, streamerId),
    listSocialAccountsByStreamer(env, streamerId),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  if (!streamer || !account) return;

  const text =
    `Отвязать ${PLATFORM_DISPLAY[account.platform]} (${account.platform_username}) от стримера «${streamer.display_name}»?\n\n` +
    `Бот перестанет отслеживать этот аккаунт. Уже опубликованные посты не удаляются.`;
  const kb = new InlineKeyboard()
    .text("✅ Да, отвязать", `set:rac:${streamerId}:${accountId}`)
    .row()
    .text("❌ Отмена", `set:str:${streamerId}`);

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function renderConfirmRemoveLink(ctx: BotContext, env: Env, streamerId: number, linkId: number): Promise<void> {
  const [streamer, links] = await Promise.all([
    getStreamerById(env, streamerId),
    listExtraLinksByStreamer(env, streamerId),
  ]);
  const link = links.find((l) => l.id === linkId);
  if (!streamer || !link) return;

  const text = `Убрать дополнительную ссылку «${link.label}» (${link.url}) у стримера «${streamer.display_name}»?`;
  const kb = new InlineKeyboard()
    .text("✅ Да, убрать", `set:rlc:${streamerId}:${linkId}`)
    .row()
    .text("❌ Отмена", `set:str:${streamerId}`);

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function renderConfirmRemoveStreamer(ctx: BotContext, env: Env, streamerId: number): Promise<void> {
  const streamer = await getStreamerById(env, streamerId);
  if (!streamer) return;
  const accounts = await listSocialAccountsByStreamer(env, streamerId);
  const platforms = accounts.map((a) => PLATFORM_DISPLAY[a.platform]).join(", ") || "нет привязанных аккаунтов";

  const text =
    `🗑 Удалить стримера «${streamer.display_name}» целиком?\n\n` +
    `Будут отвязаны все его аккаунты (${platforms}), удалены дополнительные ссылки и история постов. ` +
    `Отменить это действие нельзя.`;
  const kb = new InlineKeyboard()
    .text("✅ Да, удалить", `set:rsc:${streamerId}`)
    .row()
    .text("❌ Отмена", `set:str:${streamerId}`);

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function handleTemplateInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  await updateChannelTemplate(env, data.channel_id, text);
  await ctx.reply("✅ Текст уведомления обновлён.");
}
