import { Bot, Context, GrammyError, InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import {
  countDistinctReportingChats,
  createChannel,
  createExtraLink,
  createKickOAuthState,
  createPendingMessageDeletion,
  createSocialAccount,
  createStreamer,
  createUserReport,
  deleteChannelsByTelegramChatId,
  deleteExtraLink,
  getChannelById,
  getChannelByOwnerAndChatId,
  getChannelByTelegramChatId,
  getStreamerById,
  listChannelsByOwner,
  listExtraLinksByStreamer,
  listSocialAccountsByStreamer,
  listStreamersByChannel,
  setSession,
  toggleChannelFlag,
  updateChannelAntilinkWhitelist,
  updateChannelLeaveTemplate,
  updateChannelSpamPhrases,
  updateChannelTemplate,
  updateChannelWelcomeDeleteAfter,
  updateChannelWelcomeTemplate,
  updateExtraLinkUrl,
} from "../db.js";
import { bioLooksLikeSpam, escapeHtml, isMemberStatus } from "../lib/chat-membership.js";
import {
  DEFAULT_LEAVE_TEMPLATE,
  DEFAULT_WELCOME_DELETE_AFTER_SECONDS,
  DEFAULT_WELCOME_TEMPLATE,
  LEAVE_TEMPLATE_MAX_LENGTH,
  SPAM_PHRASE_MAX_LENGTH,
  SPAM_PHRASE_MIN_LENGTH,
  SPAM_PHRASE_PAGE_SIZE,
  TELEGRAM_CAPTION_LIMIT,
  WELCOME_TEMPLATE_MAX_LENGTH,
  addSpamPhrases,
  formatDeleteAfter,
  removeSpamPhraseAt,
  renderLeaveText,
  renderWelcomeText,
  resolveLeaveTemplate,
  resolveSpamPhrases,
  resolveWelcomeTemplate,
  serializeSpamPhrases,
  validateLeaveTemplate,
  validateWelcomeDeleteAfterMinutes,
  validateWelcomeTemplate,
  type SpamPhraseSkipReason,
} from "../lib/moderation-settings.js";
import {
  ANTILINK_WHITELIST_PAGE_SIZE,
  addWhitelistEntries,
  messageHasDisallowedLink,
  removeWhitelistEntryAt,
  resolveAntilinkWhitelist,
  serializeAntilinkWhitelist,
  type WhitelistSkipReason,
} from "../lib/antilink.js";
import { estimateRegistrationDate, formatApproximateRegistrationDate } from "../lib/registration-date-estimate.js";
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
      "NeuroINFO следит за стримерами на YouTube/TikTok/Kick и присылает уведомление «в эфире» или «новое видео» " +
        "в ваш Telegram-канал или группу — с кнопкой на каждую платформу, плюс любые дополнительные ссылки " +
        "(Twitch, Discord и т.д.), которые показываются в каждом уведомлении независимо от того, какая " +
        "платформа его вызвала.\n\n" +
        "Настройка:\n" +
        "1) Добавьте меня админом (с правом «закреплять сообщения») в канал или группу.\n" +
        "2) Зарегистрируйте её:\n" +
        "   • Группа: отправьте /add_channel прямо в группе.\n" +
        "   • Канал: перешлите мне сюда, в личку, любой пост из канала.\n" +
        "3) Вернитесь в эту личку и отправьте /add_social, чтобы привязать стримера.\n" +
        "4) Команда /settings в любой момент — изменить текст уведомления, поведение закрепления, а также " +
        "отвязать, изменить или удалить любую соцсеть/ссылку стримера (раздел «👤 Управлять стримерами»).\n\n" +
        "Если один и тот же стример одновременно в эфире на нескольких отслеживаемых платформах, я объединяю " +
        "это в одно сообщение с кнопкой на каждую платформу вместо дублей.\n\n" +
        "Модерация в группах (где я админ): приветствую новых участников, а команда /report в ответ на сообщение " +
        "позволяет пожаловаться на участника — если на него жалуются минимум 2 разные группы, я блокирую его на 30 дней.",
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

  bot.command("report", async (ctx) => {
    await handleReportCommand(ctx, env);
  });

  bot.on("my_chat_member", async (ctx) => {
    await handleMyChatMemberUpdate(ctx, env);
  });

  bot.on("chat_member", async (ctx) => {
    await handleChatMemberUpdate(ctx, env);
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

  // Catch-all for every incoming message: private-chat messages (forwarded
  // channel posts for registration, free-text replies for the multi-step
  // flows below) and, separately, group/supergroup messages (AntiLink).
  // Channel posts are a different Bot API update type (channel_post,
  // which this bot doesn't subscribe to), so they never reach this
  // handler at all -- nothing here applies to channels.
  bot.on("message", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      await handleGroupMessage(ctx, env);
      return;
    }
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
    } else if (session.step === "awaiting_link_url_edit") {
      await handleLinkUrlEditInput(ctx, env, session.data);
    } else if (session.step === "awaiting_template") {
      await handleTemplateInput(ctx, env, session.data);
    } else if (session.step === "awaiting_welcome_template") {
      await handleWelcomeTemplateInput(ctx, env, session.data);
    } else if (session.step === "awaiting_welcome_delete_after") {
      await handleWelcomeDeleteAfterInput(ctx, env, session.data);
    } else if (session.step === "awaiting_leave_template") {
      await handleLeaveTemplateInput(ctx, env, session.data);
    } else if (session.step === "awaiting_spam_phrases") {
      await handleSpamPhrasesInput(ctx, env, session.data);
    } else if (session.step === "awaiting_antilink_whitelist") {
      await handleAntilinkWhitelistInput(ctx, env, session.data);
    }
  });
}

// ---------------------------------------------------------------------------
// AntiLink: проверяет каждое обычное сообщение в группе/супергруппе, пока
// antilink_enabled включён у этого чата, и удаляет его, если там есть хотя
// бы одна ссылка не из белого списка (см. src/lib/antilink.ts — там же
// вся логика извлечения ссылок и сравнения с белым списком).
// ---------------------------------------------------------------------------

/** Админы и создатель группы не фильтруются -- иначе сам владелец или
 * любой назначенный им админ не смог бы отправить в своей же группе ни
 * одной ссылки, не добавив предварительно её домен в белый список. Это
 * не настраиваемая опция: освобождение администраторов от такого фильтра
 * — почти универсально ожидаемое поведение для подобных ботов, отдельный
 * тумблер на этот счёт не запрашивался. */
async function isExemptFromAntilink(ctx: BotContext, chatId: number, userId: number): Promise<boolean> {
  const member = await ctx.api.getChatMember(chatId, userId).catch((err) => {
    console.error(`getChatMember failed while checking AntiLink exemption for user ${userId} in chat ${chatId}:`, err);
    return null;
  });
  // Fails OPEN on purpose, the same reasoning as the report/bio-spam ban
  // check in handleMemberJoined above: if the status check itself fails
  // (a transient API error), wrongly deleting a real administrator's
  // message is worse than occasionally missing one spam link while the
  // API is having trouble -- and the next offending message from a
  // genuine non-admin still gets caught normally.
  if (!member) return true;
  return member.status === "creator" || member.status === "administrator";
}

async function handleGroupMessage(ctx: BotContext, env: Env): Promise<void> {
  const chat = ctx.chat;
  const message = ctx.message;
  // bot.on("message", ...) в registerHandlers всегда даёт контекст с
  // chat/message — тот же случай, что и в handleReportCommand выше:
  // BotContext сам по себе типизирует их как опциональные.
  if (!chat || !message) return;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!ctx.from || ctx.from.is_bot) return; // ничьи сообщения от ботов (включая сервисные) не трогаем

  const channel = await getChannelByTelegramChatId(env, chat.id).catch((err) => {
    console.error(`getChannelByTelegramChatId failed for chat ${chat.id} while checking AntiLink:`, err);
    return null;
  });
  // В отличие от welcome/spam_filter, у antilink_enabled нет предположения
  // "включено, пока не зарегистрировано иначе" — он выключен по умолчанию
  // (см. комментарий у channels.antilink_enabled в schema.sql), так что
  // незарегистрированный чат (channel === null) просто ничего не фильтрует.
  if (!channel || !channel.antilink_enabled) return;

  const whitelist = resolveAntilinkWhitelist(channel.antilink_whitelist);
  if (!messageHasDisallowedLink(message, whitelist)) return;

  if (await isExemptFromAntilink(ctx, chat.id, ctx.from.id)) return;

  await ctx.api.deleteMessage(chat.id, message.message_id).catch((err) => {
    console.error(`deleteMessage (AntiLink) failed for message ${message.message_id} in chat ${chat.id}:`, err);
  });
}

// ---------------------------------------------------------------------------
// Присутствие бота в группе/канале: добавление (с проверкой, что добавил
// админ), исключение (полная очистка настроек этого чата), назначение
// прав администратора отдельным более поздним действием.
// ---------------------------------------------------------------------------

/** Сколько РАЗНЫХ групп должны пожаловаться на одного человека (через
 * /report), прежде чем бот начнёт банить его при попытке вступить в любую
 * группу, где сам является админом. См. схему user_reports и
 * countDistinctReportingChats в src/db.ts — почему это именно «разных
 * групп», а не «разных людей одной группы». */
const REPORT_BAN_THRESHOLD = 2;

/** Секунд в 30 днях — срок временного бана, как для срабатывания по
 * порогу жалоб, так и для срабатывания по bio-спам-фильтру. Единый срок
 * для обоих триггеров: разная длительность для «жалобы» и «спам-bio» не
 * была запрошена, а лишние настраиваемые параметры без явного запроса
 * добавляют сложность без пользы. */
const REPORT_BAN_DURATION_SECONDS = 30 * 24 * 60 * 60;

/** Банит userId в chatId на REPORT_BAN_DURATION_SECONDS (Telegram сам
 * снимет бан по истечении срока — until_date, а не отдельная запись в
 * нашей БД о том, до какого числа длится бан: если человек всё ещё
 * состоит в «чёрном списке» после разбана по времени и попытается
 * вступить снова, тот же самый chat_member-обработчик отработает заново и
 * забанит его на новый срок). Ошибки не выбрасывает наружу — например,
 * если у бота вдруг нет прав ограничивать участников в этом конкретном
 * чате — только логирует, чтобы разовый сбой одной операции не обрывал
 * остальную обработку обновления.
 */
async function banMemberTemporarily(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  const untilDate = Math.floor(Date.now() / 1000) + REPORT_BAN_DURATION_SECONDS;
  await ctx.api
    .banChatMember(chatId, userId, { until_date: untilDate })
    .catch((err) => console.error(`banChatMember failed for user ${userId} in chat ${chatId}:`, err));
}

async function handleReportCommand(ctx: BotContext, env: Env): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return; // bot.command("report", ...) всегда даёт message-контекст с chat, но BotContext сам по себе типизирует его как опциональный
  if (chat.type !== "group" && chat.type !== "supergroup") {
    await ctx.reply("Команда /report работает только в группах.");
    return;
  }

  const target = ctx.message?.reply_to_message?.from;
  if (!target) {
    await ctx.reply("Ответьте командой /report на сообщение того, на кого хотите пожаловаться.");
    return;
  }
  if (target.is_bot) {
    await ctx.reply("Нельзя пожаловаться на бота.");
    return;
  }
  const reporter = ctx.from;
  if (!reporter) return;
  if (target.id === reporter.id) {
    await ctx.reply("Нельзя пожаловаться на самого себя.");
    return;
  }

  // Заявитель должен САМ сейчас быть участником этой группы (не вышедшим
  // сразу после подачи жалобы, не кем-то без реального отношения к
  // группе) — см. обсуждение при выборе этого решения.
  const reporterMember = await ctx.api.getChatMember(chat.id, reporter.id).catch((err) => {
    console.error(`getChatMember (report) failed for reporter ${reporter.id} in chat ${chat.id}:`, err);
    return null;
  });
  if (!reporterMember || !isMemberStatus(reporterMember)) {
    await ctx.reply("Подать жалобу может только действующий участник этой группы.");
    return;
  }

  // Если БД недоступна, честно говорим, что жалоба НЕ записана, — иначе
  // человек останется уверен, что пожаловался (глобальный bot.catch
  // только пишет в лог и ничего не отвечает пользователю).
  let reportCount: number;
  try {
    const outcome = await createUserReport(env, target.id, reporter.id, chat.id);
    if (outcome === "already_reported_from_this_chat") {
      await ctx.reply("На этого участника уже есть активная жалоба от этой группы.");
      return;
    }
    reportCount = await countDistinctReportingChats(env, target.id);
  } catch (err) {
    console.error(`/report failed to record or count a report against user ${target.id} in chat ${chat.id}:`, err);
    await ctx.reply("Не удалось обработать жалобу из-за временной ошибки. Попробуйте ещё раз чуть позже.");
    return;
  }

  if (reportCount >= REPORT_BAN_THRESHOLD) {
    await banMemberTemporarily(ctx, chat.id, target.id);
    await ctx.reply(
      `Жалоба принята. На этого участника набралось ${reportCount} жалоб(ы) из разных групп — он временно заблокирован в этой группе на 30 дней.`,
    );
  } else {
    await ctx.reply(
      `Жалоба принята (${reportCount} из ${REPORT_BAN_THRESHOLD} групп, необходимых для блокировки).`,
    );
  }
}

async function handleMyChatMemberUpdate(ctx: BotContext, env: Env): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup" && chat.type !== "channel") return;

  const wasMember = isMemberStatus(update.old_chat_member);
  const isNowMember = isMemberStatus(update.new_chat_member);
  const noun = chat.type === "channel" ? "канал" : "группу";

  // Бот только что покинул чат (исключён администратором или вышел сам) —
  // обнуляем все настройки, зарегистрированные для этого чата, у всех
  // владельцев (см. deleteChannelsByTelegramChatId в src/db.ts на тему
  // того, почему это не привязано к одному конкретному owner_user_id).
  if (wasMember && !isNowMember) {
    await deleteChannelsByTelegramChatId(env, chat.id);
    return;
  }

  // Бот только что добавлен (ранее не состоял в чате, теперь состоит —
  // независимо от того, дали ему сразу права администратора или только
  // права обычного участника).
  if (!wasMember && isNowMember) {
    const actor = update.from;

    // Fails closed on purpose: if this lookup itself fails (a transient
    // Telegram API error), actorMember stays null and actorIsAdmin below
    // becomes false -- same outcome as a confirmed non-admin. The
    // asymmetry is deliberate: worst case on a network hiccup is the bot
    // leaves and an admin re-adds it, which is a minor inconvenience; the
    // alternative (fail open, treat a lookup failure as "assume admin")
    // would let exactly the case point 4 asks to block -- a non-admin
    // adding the bot -- through undetected during any such hiccup.
    const actorMember = await ctx.api.getChatMember(chat.id, actor.id).catch((err) => {
      console.error(`getChatMember failed while checking who added the bot to chat ${chat.id}:`, err);
      return null;
    });
    const actorIsAdmin =
      !!actorMember && (actorMember.status === "creator" || actorMember.status === "administrator");

    if (!actorIsAdmin) {
      await ctx.api
        .sendMessage(
          chat.id,
          `Добавлять меня в ${noun} может только администратор. Покидаю чат — попросите администратора добавить меня снова.`,
        )
        .catch(() => undefined);
      await ctx.api.leaveChat(chat.id).catch(() => undefined);
      return;
    }

    const actorName = actor.username ? `@${actor.username}` : actor.first_name;
    await ctx.api
      .sendMessage(
        chat.id,
        "🤖 <b>NeuroINFO</b> — бот для уведомлений о стримах\n\n" +
          "Я слежу за стримерами на YouTube, TikTok и Kick и мгновенно присылаю сюда сообщение, когда " +
          "кто-то из них начинает трансляцию или выпускает новое видео — с кнопкой на каждую соцсеть " +
          "стримера (YouTube, TikTok, Kick, Twitch, Discord и другие, любые ссылки настраиваются).\n\n" +
          "<b>Как настроить для этого чата:</b>\n" +
          "1. Отправьте здесь, в группе, команду /add_channel — так вы зарегистрируете этот чат за собой.\n" +
          "2. Напишите мне в личные сообщения /add_social — привяжете стримера и его аккаунты.\n" +
          "3. Команда /settings в личке — автозакрепление, текст уведомления, стримеры, а также приветствие " +
          "новых участников и список спам-фраз для этого чата.\n\n" +
          "Чтобы приветствовать новичков и блокировать спамеров, мне нужны права администратора " +
          "(с правом блокировки участников).\n\n" +
          `Спасибо администратору ${escapeHtml(actorName)} этого чата за то, что выбрал(а) именно меня! ` +
          `Разработчик бота — <a href="https://t.me/WZ_Casper">亗 Casper</a>.`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      )
      .catch(() => undefined);
    return;
  }

  // Осталось изменение статуса, при котором бот и до, и после числится
  // участником (например, только что назначили админом отдельным
  // действием после обычного добавления) — этому чату можно продолжать
  // отправлять команду /add_channel как обычно, дополнительной реакции
  // здесь не требуется.
}

async function handleChatMemberUpdate(ctx: BotContext, env: Env): Promise<void> {
  const update = ctx.chatMember;
  if (!update) return;
  const chat = update.chat;
  // Только группы/супергруппы — у каналов нет привычного «участник
  // вступил»/«вышел», а сам bot.on("chat_member") в принципе не
  // срабатывает для private-чатов (см. официальную документацию
  // Update.chat_member).
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const wasMember = isMemberStatus(update.old_chat_member);
  const isNowMember = isMemberStatus(update.new_chat_member);

  // Ровно два интересующих перехода: «не был участником -> стал» (вступил
  // впервые) и «был участником -> перестал» (вышел сам или был исключён
  // администратором — ChatMemberUpdated не различает эти два случая
  // отдельным полем, оба дают статус "left"/"kicked" у new_chat_member, и
  // объявление о выходе одинаково уместно в обоих случаях). Любой другой
  // переход (например, «участник» -> «администратор», или повторная
  // проверка статуса без реального изменения) этот бот не обрабатывает.
  if (!wasMember && isNowMember) {
    await handleMemberJoined(ctx, env, chat, update.new_chat_member.user);
  } else if (wasMember && !isNowMember) {
    await handleMemberLeft(ctx, env, chat, update.new_chat_member.user);
  }
}

async function handleMemberJoined(
  ctx: BotContext,
  env: Env,
  chat: { id: number; type: "group" | "supergroup"; title: string },
  newMember: NonNullable<BotContext["chatMember"]>["new_chat_member"]["user"],
): Promise<void> {
  if (newMember.is_bot) return; // приветствуем людей, не сервисных ботов (включая самого себя)

  // Настройки этого чата, если его кто-то зарегистрировал через /add_channel
  // (там же владелец меняет текст приветствия и список спам-фраз). Если чат
  // не зарегистрирован или настройки не прочитались — стандартные:
  // приветствие и проверка bio включены, тексты и фразы встроенные.
  const channel = await getChannelByTelegramChatId(env, chat.id).catch((err) => {
    console.error(`getChannelByTelegramChatId failed for chat ${chat.id}, using default moderation settings:`, err);
    return null;
  });
  const welcomeEnabled = channel ? Boolean(channel.welcome_enabled) : true;
  const spamFilterEnabled = channel ? Boolean(channel.spam_filter_enabled) : true;

  // Два независимых триггера немедленного временного бана вместо
  // приветствия: (а) на человека уже подано 2+ жалобы из разных групп
  // (порог достигнут, возможно, ещё до того, как он вступил именно сюда —
  // это тот самый механизм «банить при попытке вступить в ЛЮБУЮ группу,
  // где бот админ», см. countDistinctReportingChats/handleReportCommand);
  // (б) его bio совпало с фразой из списка этого чата (см. bioLooksLikeSpam)
  // прямо в момент именно этого вступления — жалоб на него при этом может
  // не быть вовсе. Триггер (а) от переключателя проверки bio не зависит.
  //
  // Fails OPEN on purpose, the opposite of the "who added the bot" check
  // in handleMyChatMemberUpdate: there, wrongly letting someone through
  // violated an explicit requirement (only admins may add the bot); here
  // the wrong outcome of failing closed would be a 30-day ban of an
  // innocent person because the database blinked, which is a far worse and
  // harder-to-undo harm than letting a genuinely-reported person through
  // for one join (they get re-checked on their next join, and any further
  // /report re-triggers the ban). A DB error must also not abort the whole
  // handler and take the welcome message down with it.
  const reportCount = await countDistinctReportingChats(env, newMember.id).catch((err) => {
    console.error(`countDistinctReportingChats failed for user ${newMember.id}, treating as 0 reports:`, err);
    return 0;
  });

  let bioIsSpam = false;
  if (spamFilterEnabled) {
    const chatInfo = await ctx.api.getChat(newMember.id).catch((err) => {
      console.error(`getChat failed while checking bio for user ${newMember.id}:`, err);
      return null;
    });
    const bio = chatInfo && "bio" in chatInfo ? chatInfo.bio : undefined;
    bioIsSpam = bioLooksLikeSpam(bio, resolveSpamPhrases(channel?.spam_phrases));
  }

  if (reportCount >= REPORT_BAN_THRESHOLD || bioIsSpam) {
    await banMemberTemporarily(ctx, chat.id, newMember.id);
    return;
  }

  if (!welcomeEnabled) return;

  const fullName = newMember.last_name ? `${newMember.first_name} ${newMember.last_name}` : newMember.first_name;
  const text = renderWelcomeText(resolveWelcomeTemplate(channel?.welcome_template), {
    name: fullName,
    username: newMember.username ? `@${newMember.username}` : "— не указан",
    registered: formatApproximateRegistrationDate(estimateRegistrationDate(newMember.id)),
    chat: chat.title,
  });

  // Обычный текст без parse_mode: владелец чата может написать в
  // приветствии что угодно (включая «<» и «&»), и это не превратится в
  // разметку.
  const sendPlain = async (): Promise<number | null> => {
    const msg = await ctx.api.sendMessage(chat.id, text).catch((err) => {
      console.error(`sendMessage (welcome) failed in chat ${chat.id}:`, err);
      return null;
    });
    return msg?.message_id ?? null;
  };

  const photos = await ctx.api.getUserProfilePhotos(newMember.id, { limit: 1 }).catch((err) => {
    console.error(`getUserProfilePhotos failed for user ${newMember.id}:`, err);
    return null;
  });
  const bestPhoto = photos?.photos[0]?.at(-1); // последний размер в списке — самый крупный

  // Подпись к фото у Telegram ограничена 1024 символами; если после
  // подстановок текст длиннее, шлём обычным сообщением без фото. Так же —
  // если у человека нет фото или оно скрыто настройками приватности, или
  // если сама отправка фото не удалась.
  let sentMessageId: number | null;
  if (bestPhoto && text.length <= TELEGRAM_CAPTION_LIMIT) {
    sentMessageId = await ctx.api
      .sendPhoto(chat.id, bestPhoto.file_id, { caption: text })
      .then((msg) => msg.message_id)
      .catch(async (err) => {
        console.error(`sendPhoto (welcome) failed in chat ${chat.id}, falling back to plain message:`, err);
        return sendPlain();
      });
  } else {
    sentMessageId = await sendPlain();
  }

  // Автоудаление приветствия: само удаление делает крон (src/scheduled.ts),
  // здесь только ставим сообщение в очередь. 0 — «не удалять».
  const deleteAfterSeconds = channel?.welcome_delete_after_seconds ?? DEFAULT_WELCOME_DELETE_AFTER_SECONDS;
  if (sentMessageId && deleteAfterSeconds > 0) {
    await createPendingMessageDeletion(env, chat.id, sentMessageId, deleteAfterSeconds).catch((err) =>
      console.error(`createPendingMessageDeletion failed for message ${sentMessageId} in chat ${chat.id}:`, err),
    );
  }
}

/** Mirror of handleMemberJoined above, for the opposite transition: a
 * member left on their own, or was removed by an administrator (both give
 * the same "left"/"kicked" new_chat_member.status, and ChatMemberUpdated
 * carries no separate field distinguishing the two — see the comment in
 * handleChatMemberUpdate above). No bio/report ban checks here: those only
 * make sense when someone is trying to get IN, not on the way out. Sent as
 * a plain message with no profile-photo attachment, unlike the welcome
 * message -- there's no equivalent reason to attach one for someone who
 * just left, so it also has no TELEGRAM_CAPTION_LIMIT concern the welcome
 * path has to work around. */
async function handleMemberLeft(
  ctx: BotContext,
  env: Env,
  chat: { id: number; type: "group" | "supergroup"; title: string },
  leftMember: NonNullable<BotContext["chatMember"]>["new_chat_member"]["user"],
): Promise<void> {
  if (leftMember.is_bot) return; // не объявляем о «выходе» сервисных ботов (включая самого себя)

  const channel = await getChannelByTelegramChatId(env, chat.id).catch((err) => {
    console.error(`getChannelByTelegramChatId failed for chat ${chat.id}, using default moderation settings:`, err);
    return null;
  });
  const leaveEnabled = channel ? Boolean(channel.leave_enabled) : true;
  if (!leaveEnabled) return;

  const fullName = leftMember.last_name ? `${leftMember.first_name} ${leftMember.last_name}` : leftMember.first_name;
  const text = renderLeaveText(resolveLeaveTemplate(channel?.leave_template), {
    name: fullName,
    username: leftMember.username ? `@${leftMember.username}` : "— не указан",
    chat: chat.title,
  });

  // Обычный текст без parse_mode — по той же причине, что и у приветствия
  // выше: владелец чата может написать в тексте что угодно, включая «<»
  // и «&», и это не превратится в разметку.
  const sentMessage = await ctx.api.sendMessage(chat.id, text).catch((err) => {
    console.error(`sendMessage (leave) failed in chat ${chat.id}:`, err);
    return null;
  });

  // Та же очередь автоудаления и та же задержка, что и у приветствия выше
  // -- одна общая настройка «через сколько удалять» на оба вида
  // сообщений, а не отдельная задержка на каждое, см. комментарий у
  // channels.leave_enabled в schema.sql.
  const deleteAfterSeconds = channel?.welcome_delete_after_seconds ?? DEFAULT_WELCOME_DELETE_AFTER_SECONDS;
  if (sentMessage && deleteAfterSeconds > 0) {
    await createPendingMessageDeletion(env, chat.id, sentMessage.message_id, deleteAfterSeconds).catch((err) =>
      console.error(`createPendingMessageDeletion failed for message ${sentMessage.message_id} in chat ${chat.id}:`, err),
    );
  }
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

async function handleLinkUrlEditInput(
  ctx: BotContext,
  env: Env,
  data: { streamer_id: number; link_id: number },
): Promise<void> {
  const raw = ctx.message?.text?.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  await updateExtraLinkUrl(env, data.link_id, url);
  await ctx.reply("✅ Ссылка обновлена.");
}

// ---------------------------------------------------------------------------
// /settings
// ---------------------------------------------------------------------------

async function handleSettingsCallback(ctx: BotContext, env: Env, rest: string[]): Promise<void> {
  const action = rest[0];

  if (action === "menu") {
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    const kb = new InlineKeyboard();
    for (const ch of channels) kb.text(ch.title ?? String(ch.telegram_chat_id), `set:ch:${ch.id}`).row();
    await ctx.editMessageText("Какой канал/группа?", { reply_markup: kb });
    return;
  }

  if (action === "ch" && rest[1]) {
    const channel = await getChannelById(env, Number(rest[1]));
    if (channel) await renderChannelSettings(ctx, env, channel);
    return;
  }

  if (action && MODERATION_ACTIONS.has(action) && rest[1]) {
    await handleModerationCallback(ctx, env, action, rest);
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
      `Отправьте новый текст уведомления (показывается под заголовком «\u{1F534} {streamer} начал трансляцию!»).\nПлейсхолдеры: {title} {game}\n\nПо умолчанию:\n${DEFAULT_TEMPLATE}`,
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

  if (action === "el" && rest[1] && rest[2]) {
    const streamerId = Number(rest[1]);
    const linkId = Number(rest[2]);
    const links = await listExtraLinksByStreamer(env, streamerId);
    const link = links.find((l) => l.id === linkId);
    if (!link) return;
    await setSession(env, ctx.dbUser.id, { step: "awaiting_link_url_edit", data: { streamer_id: streamerId, link_id: linkId } });
    await ctx.editMessageText(
      `Текущая ссылка «${link.label}»:\n${link.url}\n\nОтправьте новую ссылку — заменит текущую (название «${link.label}» останется тем же).`,
    );
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
    .text("👥 Модерация группы", `set:mod:${channel.id}`)
    .row()
    .text("⬅ Назад", "set:menu")
    .row()
    .text("🏠 Меню", "set:menu");

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
  kb.text("⬅ Назад", `set:ch:${channel.id}`).row();
  kb.text("🏠 Меню", "set:menu");

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
    kb.text(`✏️ Изменить «${l.label}»`, `set:el:${streamer.id}:${l.id}`).row();
    kb.text(`❌ Убрать «${l.label}»`, `set:rl:${streamer.id}:${l.id}`).row();
  }
  kb.text("🗑 Удалить стримера целиком", `set:rs:${streamer.id}`).row();
  kb.text("⬅ Назад", `set:strs:${streamer.channel_id}`).row();
  kb.text("🏠 Меню", "set:menu");

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
    .text("❌ Отмена", `set:str:${streamerId}`)
    .row()
    .text("🏠 Меню", "set:menu");

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
    .text("❌ Отмена", `set:str:${streamerId}`)
    .row()
    .text("🏠 Меню", "set:menu");

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
    .text("❌ Отмена", `set:str:${streamerId}`)
    .row()
    .text("🏠 Меню", "set:menu");

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function handleTemplateInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  await updateChannelTemplate(env, data.channel_id, text);
  await ctx.reply("✅ Текст уведомления обновлён.");
}

// ---------------------------------------------------------------------------
// Модерация группы: приветствие новых участников и список спам-фраз.
// Настройки свои у каждого чата; стандартные значения и вся чистая логика —
// в src/lib/moderation-settings.ts. Экран: /settings → чат → «👥 Модерация
// группы».
// ---------------------------------------------------------------------------

const MODERATION_ACTIONS = new Set([
  "mod",
  "wtg",
  "wtx",
  "wrs",
  "wdt",
  "wdr",
  "stg",
  "spl",
  "spa",
  "spd",
  "spr",
  "ltg", // leave-announcement: on/off
  "ltx", // leave-announcement: edit text
  "lrs", // leave-announcement: reset text to default
  "atg", // AntiLink: on/off
  "awl", // AntiLink whitelist: list (paginated)
  "awa", // AntiLink whitelist: add prompt
  "awd", // AntiLink whitelist: delete one entry
]);

interface View {
  text: string;
  kb: InlineKeyboard;
}

/** Чат, который зарегистрирован именно этим пользователем (через
 * /add_channel), иначе null. */
async function getOwnedChannel(ctx: BotContext, env: Env, channelId: number): Promise<ChannelRow | null> {
  const channel = await getChannelById(env, channelId);
  return channel && channel.owner_user_id === ctx.dbUser.id ? channel : null;
}

function truncateLabel(text: string, max: number): string {
  const chars = Array.from(text); // по символам, а не по кодовым единицам — эмодзи не разрезается
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** Показывает экран правкой текущего сообщения. Telegram отвечает ошибкой
 * «message is not modified», если новый текст и клавиатура совпали с
 * прежними (например, «сбросить к стандартным», когда уже стандартное) —
 * это не сбой: экран и так актуален. */
async function editScreen(ctx: BotContext, view: View): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { reply_markup: view.kb });
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
    throw err;
  }
}

function buildModerationView(channel: ChannelRow): View {
  const phrases = resolveSpamPhrases(channel.spam_phrases);
  const whitelist = resolveAntilinkWhitelist(channel.antilink_whitelist);
  const text =
    `👥 Модерация: ${channel.title ?? channel.telegram_chat_id}\n` +
    "Работает в группах, где бот — администратор (в каналах не применяется).\n\n" +
    `Приветствие новых участников: ${channel.welcome_enabled ? "вкл" : "выкл"}\n` +
    `Уведомление о выходе участника: ${channel.leave_enabled ? "вкл" : "выкл"}\n` +
    `Удаление приветствия/уведомления о выходе через: ${formatDeleteAfter(channel.welcome_delete_after_seconds)}\n` +
    `Проверка описания профиля на спам: ${channel.spam_filter_enabled ? "вкл" : "выкл"} ` +
    `(фраз в списке: ${phrases.length}; при совпадении — блокировка на 30 дней)\n` +
    `АнтиСсылка: ${channel.antilink_enabled ? "вкл" : "выкл"} ` +
    `(в белом списке: ${whitelist.length} доменов; админы группы не фильтруются)\n\n` +
    `Текст приветствия (${channel.welcome_template ? "свой" : "стандартный"}):\n` +
    `${resolveWelcomeTemplate(channel.welcome_template)}\n\n` +
    `Текст уведомления о выходе (${channel.leave_template ? "свой" : "стандартный"}):\n` +
    resolveLeaveTemplate(channel.leave_template);
  const kb = new InlineKeyboard()
    .text(channel.welcome_enabled ? "Выключить приветствие" : "Включить приветствие", `set:wtg:${channel.id}`)
    .row()
    .text("✏️ Изменить текст приветствия", `set:wtx:${channel.id}`)
    .row()
    .text("⏱ Время удаления приветствия/выхода", `set:wdt:${channel.id}`)
    .row()
    .text(channel.leave_enabled ? "Выключить уведомление о выходе" : "Включить уведомление о выходе", `set:ltg:${channel.id}`)
    .row()
    .text("✏️ Изменить текст уведомления о выходе", `set:ltx:${channel.id}`)
    .row()
    .text(channel.spam_filter_enabled ? "Выключить проверку спама" : "Включить проверку спама", `set:stg:${channel.id}`)
    .row()
    .text(`📝 Спам-фразы (${phrases.length})`, `set:spl:${channel.id}:0`)
    .row()
    .text(channel.antilink_enabled ? "Выключить АнтиСсылку" : "Включить АнтиСсылку", `set:atg:${channel.id}`)
    .row()
    .text(`🔗 Белый список ссылок (${whitelist.length})`, `set:awl:${channel.id}:0`)
    .row()
    .text("⬅ Назад", `set:ch:${channel.id}`)
    .row()
    .text("🏠 Меню", "set:menu");
  return { text, kb };
}

function buildWelcomePromptView(channelId: number): View {
  const text =
    `Отправьте новый текст приветствия для новых участников (обычный текст, до ${WELCOME_TEMPLATE_MAX_LENGTH} символов).\n\n` +
    "Подстановки:\n" +
    "{name} — имя и фамилия\n" +
    "{username} — ник (@...)\n" +
    "{registered} — приблизительная дата регистрации\n" +
    "{chat} — название группы\n\n" +
    `Если у человека есть фото профиля, оно прикрепляется к приветствию (при тексте длиннее ${TELEGRAM_CAPTION_LIMIT} символов — без фото).\n\n` +
    `Стандартный текст:\n${DEFAULT_WELCOME_TEMPLATE}`;
  const kb = new InlineKeyboard()
    .text("↩️ Вернуть стандартный текст", `set:wrs:${channelId}`)
    .row()
    .text("⬅ Отмена", `set:mod:${channelId}`);
  return { text, kb };
}

function buildLeavePromptView(channelId: number): View {
  const text =
    `Отправьте новый текст уведомления о выходе участника (обычный текст, до ${LEAVE_TEMPLATE_MAX_LENGTH} символов).\n\n` +
    "Показывается и когда участник вышел сам, и когда его исключил администратор.\n\n" +
    "Подстановки:\n" +
    "{name} — имя и фамилия\n" +
    "{username} — ник (@...)\n" +
    "{chat} — название группы\n\n" +
    `Стандартный текст:\n${DEFAULT_LEAVE_TEMPLATE}`;
  const kb = new InlineKeyboard()
    .text("↩️ Вернуть стандартный текст", `set:lrs:${channelId}`)
    .row()
    .text("⬅ Отмена", `set:mod:${channelId}`);
  return { text, kb };
}

function buildWelcomeDeletePromptView(channelId: number, currentSeconds: number): View {
  const text =
    "Через сколько минут после отправки удалять приветствие/уведомление о выходе из группы?\n\n" +
    `Сейчас: ${formatDeleteAfter(currentSeconds)}.\n` +
    "Отправьте число минут (например, 10). 0 — не удалять вообще. Максимум — 1440 (24 часа).";
  const kb = new InlineKeyboard()
    .text(`↩️ Вернуть стандартное (${DEFAULT_WELCOME_DELETE_AFTER_SECONDS / 60} мин)`, `set:wdr:${channelId}`)
    .row()
    .text("⬅ Отмена", `set:mod:${channelId}`);
  return { text, kb };
}

/** One page of a flat, numbered, by-position list with a ❌-delete button
 * per item plus Prev/Next navigation — the shared rendering shape behind
 * both buildSpamPhraseListView and buildAntilinkWhitelistView below, so
 * the two stay visually and behaviorally consistent rather than drifting
 * apart as separate copies. `page` is clamped into range here (not by the
 * caller) so a stale "next page" button pressed after items were removed
 * can never point past the end. */
function buildPaginatedListKeyboard(params: {
  items: readonly string[];
  page: number;
  pageSize: number;
  itemLabelLength: number;
  /** `page` here is the final, already-clamped page being shown — so the
   * delete button's callback_data carries back the page the owner was
   * actually looking at, and removing an item keeps them on the same
   * page afterward instead of jumping back to page 1. */
  deleteAction: (index: number, page: number) => string;
  pageAction: (page: number) => string;
}): { kb: InlineKeyboard; page: number; totalPages: number; pageItems: Array<{ item: string; index: number }> } {
  const totalPages = Math.max(1, Math.ceil(params.items.length / params.pageSize));
  const page = Math.min(Math.max(0, params.page), totalPages - 1);
  const start = page * params.pageSize;
  const pageItems = params.items
    .slice(start, start + params.pageSize)
    .map((item, i) => ({ item, index: start + i }));

  const kb = new InlineKeyboard();
  pageItems.forEach(({ item, index }) => {
    kb.text(`❌ ${truncateLabel(item, params.itemLabelLength)}`, params.deleteAction(index, page)).row();
  });
  if (totalPages > 1) {
    if (page > 0) kb.text("⬅️ Пред.", params.pageAction(page - 1));
    kb.text(`${page + 1}/${totalPages}`, params.pageAction(page)); // неактивная кнопка-индикатор
    if (page < totalPages - 1) kb.text("След. ➡️", params.pageAction(page + 1));
    kb.row();
  }
  return { kb, page, totalPages, pageItems };
}

function buildSpamPhraseListView(channel: ChannelRow, page = 0): View {
  const phrases = resolveSpamPhrases(channel.spam_phrases);
  const { kb, pageItems, totalPages, page: clampedPage } = buildPaginatedListKeyboard({
    items: phrases,
    page,
    pageSize: SPAM_PHRASE_PAGE_SIZE,
    itemLabelLength: 28,
    deleteAction: (i, p) => `set:spd:${channel.id}:${i}:${p}`,
    pageAction: (p) => `set:spl:${channel.id}:${p}`,
  });
  const body = pageItems.length
    ? pageItems.map(({ item, index }) => `${index + 1}. ${item}`).join("\n")
    : "(список пуст — проверка ничего не ловит)";
  const text =
    `📝 Спам-фразы: ${channel.title ?? channel.telegram_chat_id}\n` +
    "Если в описании (bio) нового участника есть любая из этих фраз, бот блокирует его на 30 дней. " +
    "Регистр и лишние пробелы не важны. Ограничения на количество фраз нет — список показывается страницами.\n\n" +
    `Всего фраз: ${phrases.length}${totalPages > 1 ? `, страница ${clampedPage + 1} из ${totalPages}` : ""}\n\n` +
    `${body}\n\n` +
    `${channel.spam_phrases === null ? "Список стандартный. " : ""}` +
    "Чтобы изменить фразу — удалите её (❌) и добавьте заново.";
  kb.text("➕ Добавить фразы", `set:spa:${channel.id}`)
    .row()
    .text("↩️ Сбросить к стандартным", `set:spr:${channel.id}`)
    .row()
    .text("⬅ Назад", `set:mod:${channel.id}`)
    .row()
    .text("🏠 Меню", "set:menu");
  return { text, kb };
}

function buildSpamAddPromptView(channelId: number): View {
  const text =
    "Отправьте фразы, которые нужно добавить, — по одной на строку.\n" +
    `Длина фразы — от ${SPAM_PHRASE_MIN_LENGTH} до ${SPAM_PHRASE_MAX_LENGTH} символов. Ограничения на общее количество фраз в списке нет. ` +
    "Слишком короткая фраза совпала бы с описаниями обычных людей и привела бы к ложным блокировкам.";
  const kb = new InlineKeyboard().text("⬅ Отмена", `set:spl:${channelId}:0`);
  return { text, kb };
}

// ---------------------------------------------------------------------------
// AntiLink: on/off toggle + whitelist editor
// ---------------------------------------------------------------------------

function buildAntilinkWhitelistView(channel: ChannelRow, page = 0): View {
  const whitelist = resolveAntilinkWhitelist(channel.antilink_whitelist);
  const { kb, pageItems, totalPages, page: clampedPage } = buildPaginatedListKeyboard({
    items: whitelist,
    page,
    pageSize: ANTILINK_WHITELIST_PAGE_SIZE,
    itemLabelLength: 32,
    deleteAction: (i, p) => `set:awd:${channel.id}:${i}:${p}`,
    pageAction: (p) => `set:awl:${channel.id}:${p}`,
  });
  const body = pageItems.length
    ? pageItems.map(({ item, index }) => `${index + 1}. ${item}`).join("\n")
    : "(белый список пуст — при включённой АнтиСсылке удаляются вообще все ссылки)";
  const text =
    `🔗 Белый список ссылок: ${channel.title ?? channel.telegram_chat_id}\n` +
    `АнтиСсылка сейчас: ${channel.antilink_enabled ? "включена" : "выключена"}.\n` +
    "Пока включена — бот удаляет из группы любое сообщение со ссылкой, чей домен не в этом списке " +
    "(поддомены разрешённого домена тоже разрешены). Администраторов группы фильтр не проверяет.\n\n" +
    `Всего доменов: ${whitelist.length}${totalPages > 1 ? `, страница ${clampedPage + 1} из ${totalPages}` : ""}\n\n` +
    `${body}`;
  kb.text("➕ Добавить домены", `set:awa:${channel.id}`)
    .row()
    .text("⬅ Назад", `set:mod:${channel.id}`)
    .row()
    .text("🏠 Меню", "set:menu");
  return { text, kb };
}

function buildAntilinkWhitelistAddPromptView(channelId: number): View {
  const text =
    "Отправьте домены или ссылки, которые нужно разрешить, — по одной на строку.\n" +
    "Например:\nyoutube.com\nhttps://vk.com/\nt.me\n\n" +
    "Поддомены указанного домена разрешаются автоматически (youtube.com разрешит и www.youtube.com, и m.youtube.com). " +
    "Ограничения на количество доменов в списке нет.";
  const kb = new InlineKeyboard().text("⬅ Отмена", `set:awl:${channelId}:0`);
  return { text, kb };
}

async function handleModerationCallback(ctx: BotContext, env: Env, action: string, rest: string[]): Promise<void> {
  const channel = await getOwnedChannel(ctx, env, Number(rest[1]));
  if (!channel) {
    await editScreen(ctx, {
      text: "Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Откройте /settings заново.",
      kb: new InlineKeyboard().text("🏠 Меню", "set:menu"),
    });
    return;
  }

  switch (action) {
    case "mod": {
      await setSession(env, ctx.dbUser.id, IDLE_SESSION); // «Отмена» с экрана ввода тоже приходит сюда
      await editScreen(ctx, buildModerationView(channel));
      return;
    }
    case "wtg":
    case "stg":
    case "ltg":
    case "atg": {
      const flag =
        action === "wtg"
          ? "welcome_enabled"
          : action === "stg"
            ? "spam_filter_enabled"
            : action === "ltg"
              ? "leave_enabled"
              : "antilink_enabled";
      const updated = await toggleChannelFlag(env, channel.id, flag);
      await editScreen(ctx, buildModerationView(updated ?? channel));
      return;
    }
    case "wtx": {
      await setSession(env, ctx.dbUser.id, { step: "awaiting_welcome_template", data: { channel_id: channel.id } });
      await editScreen(ctx, buildWelcomePromptView(channel.id));
      return;
    }
    case "wrs": {
      const updated = await updateChannelWelcomeTemplate(env, channel.id, null);
      await setSession(env, ctx.dbUser.id, IDLE_SESSION);
      await editScreen(ctx, buildModerationView(updated ?? channel));
      return;
    }
    case "ltx": {
      await setSession(env, ctx.dbUser.id, { step: "awaiting_leave_template", data: { channel_id: channel.id } });
      await editScreen(ctx, buildLeavePromptView(channel.id));
      return;
    }
    case "lrs": {
      const updated = await updateChannelLeaveTemplate(env, channel.id, null);
      await setSession(env, ctx.dbUser.id, IDLE_SESSION);
      await editScreen(ctx, buildModerationView(updated ?? channel));
      return;
    }
    case "wdt": {
      await setSession(env, ctx.dbUser.id, { step: "awaiting_welcome_delete_after", data: { channel_id: channel.id } });
      await editScreen(ctx, buildWelcomeDeletePromptView(channel.id, channel.welcome_delete_after_seconds));
      return;
    }
    case "wdr": {
      const updated = await updateChannelWelcomeDeleteAfter(env, channel.id, DEFAULT_WELCOME_DELETE_AFTER_SECONDS);
      await setSession(env, ctx.dbUser.id, IDLE_SESSION);
      await editScreen(ctx, buildModerationView(updated ?? channel));
      return;
    }
    case "spl": {
      await setSession(env, ctx.dbUser.id, IDLE_SESSION);
      await editScreen(ctx, buildSpamPhraseListView(channel, Number(rest[2] ?? 0)));
      return;
    }
    case "spa": {
      await setSession(env, ctx.dbUser.id, { step: "awaiting_spam_phrases", data: { channel_id: channel.id } });
      await editScreen(ctx, buildSpamAddPromptView(channel.id));
      return;
    }
    case "spd": {
      // Индекс относится к списку в момент показа экрана; если список
      // успел измениться (устаревшая кнопка), removeSpamPhraseAt вернёт null
      // и ничего не удалится — экран просто обновится. rest[3] несёт номер
      // страницы, с которой была нажата кнопка удаления, чтобы после
      // удаления остаться на той же странице, а не перескакивать на первую.
      const next = removeSpamPhraseAt(resolveSpamPhrases(channel.spam_phrases), Number(rest[2]));
      const updated = next ? await updateChannelSpamPhrases(env, channel.id, serializeSpamPhrases(next)) : channel;
      await editScreen(ctx, buildSpamPhraseListView(updated ?? channel, Number(rest[3] ?? 0)));
      return;
    }
    case "spr": {
      const updated = await updateChannelSpamPhrases(env, channel.id, null);
      await editScreen(ctx, buildSpamPhraseListView(updated ?? channel, 0));
      return;
    }
    case "awl": {
      await setSession(env, ctx.dbUser.id, IDLE_SESSION);
      await editScreen(ctx, buildAntilinkWhitelistView(channel, Number(rest[2] ?? 0)));
      return;
    }
    case "awa": {
      await setSession(env, ctx.dbUser.id, { step: "awaiting_antilink_whitelist", data: { channel_id: channel.id } });
      await editScreen(ctx, buildAntilinkWhitelistAddPromptView(channel.id));
      return;
    }
    case "awd": {
      // Та же логика «устаревшей кнопки», что и у spd выше, и то же
      // сохранение текущей страницы после удаления.
      const next = removeWhitelistEntryAt(resolveAntilinkWhitelist(channel.antilink_whitelist), Number(rest[2]));
      const updated = next ? await updateChannelAntilinkWhitelist(env, channel.id, serializeAntilinkWhitelist(next)) : channel;
      await editScreen(ctx, buildAntilinkWhitelistView(updated ?? channel, Number(rest[3] ?? 0)));
      return;
    }
  }
}

async function handleWelcomeTemplateInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const raw = ctx.message?.text;
  if (!raw) return;

  const channel = await getOwnedChannel(ctx, env, data.channel_id);
  if (!channel) {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply("Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Начните с /settings.");
    return;
  }

  const checked = validateWelcomeTemplate(raw);
  if (!checked.ok) {
    await ctx.reply(checked.error); // остаёмся в режиме ввода — можно отправить исправленный текст
    return;
  }

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const updated = await updateChannelWelcomeTemplate(env, channel.id, checked.template);
  const view = buildModerationView(updated ?? channel);
  await ctx.reply(`✅ Текст приветствия обновлён.\n\n${view.text}`, { reply_markup: view.kb });
}

async function handleWelcomeDeleteAfterInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const raw = ctx.message?.text;
  if (!raw) return;

  const channel = await getOwnedChannel(ctx, env, data.channel_id);
  if (!channel) {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply("Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Начните с /settings.");
    return;
  }

  const checked = validateWelcomeDeleteAfterMinutes(raw);
  if (!checked.ok) {
    await ctx.reply(checked.error); // остаёмся в режиме ввода — можно отправить исправленное значение
    return;
  }

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const updated = await updateChannelWelcomeDeleteAfter(env, channel.id, checked.seconds);
  const view = buildModerationView(updated ?? channel);
  await ctx.reply(`✅ Время удаления приветствия обновлено.\n\n${view.text}`, { reply_markup: view.kb });
}

function describeSpamSkipReason(reason: SpamPhraseSkipReason): string {
  switch (reason) {
    case "too_short":
      return `слишком короткая (нужно от ${SPAM_PHRASE_MIN_LENGTH} символов)`;
    case "too_long":
      return `слишком длинная (не больше ${SPAM_PHRASE_MAX_LENGTH} символов)`;
    case "duplicate":
      return "уже есть в списке";
  }
}

function describeWhitelistSkipReason(skip: { reason: WhitelistSkipReason; error?: string }): string {
  switch (skip.reason) {
    case "invalid":
      return skip.error ?? "не похоже на домен или ссылку";
    case "duplicate":
      return "уже есть в списке";
  }
}

/** Маркированный список, обрезанный до `max` строк, чтобы ответ на
 * добавление пачки фраз не вышел за лимит длины сообщения Telegram. */
function bulletLines(items: string[], max = 10): string[] {
  const lines = items.slice(0, max).map((item) => `• ${item}`);
  if (items.length > max) lines.push(`…и ещё ${items.length - max}`);
  return lines;
}

async function handleSpamPhrasesInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const raw = ctx.message?.text;
  if (!raw || raw.trim() === "") return;

  const channel = await getOwnedChannel(ctx, env, data.channel_id);
  if (!channel) {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply("Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Начните с /settings.");
    return;
  }

  const result = addSpamPhrases(resolveSpamPhrases(channel.spam_phrases), raw);
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const updated =
    result.added.length > 0
      ? ((await updateChannelSpamPhrases(env, channel.id, serializeSpamPhrases(result.phrases))) ?? channel)
      : channel;

  // Отчёт о результате отправляется ОТДЕЛЬНО от полного списка (не
  // склеивается с ним в одно сообщение): при почти заполненном списке из
  // длинных фраз и большой вставленной пачке сумма легко превышает лимит
  // Telegram в 4096 символов на сообщение, и тогда пользователь не получил
  // бы вообще никакого ответа, хотя фразы уже сохранились бы в БД. Здесь
  // каждое сообщение ограничено независимо от размера списка/пачки:
  // bulletLines сама по себе обрезает до 10 строк на секцию.
  const lines: string[] = [];
  if (result.added.length > 0) lines.push(`✅ Добавлено: ${result.added.length}`, ...bulletLines(result.added));
  else lines.push("Ничего не добавлено.");
  if (result.skipped.length > 0) {
    lines.push(
      "",
      "Пропущено:",
      ...bulletLines(
        result.skipped.map((s) => `«${truncateLabel(s.phrase, 40)}» — ${describeSpamSkipReason(s.reason)}`),
      ),
    );
  }
  await ctx.reply(lines.join("\n"));

  const view = buildSpamPhraseListView(updated, 0);
  await ctx.reply(view.text, { reply_markup: view.kb });
}

async function handleLeaveTemplateInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const raw = ctx.message?.text;
  if (!raw) return;

  const channel = await getOwnedChannel(ctx, env, data.channel_id);
  if (!channel) {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply("Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Начните с /settings.");
    return;
  }

  const checked = validateLeaveTemplate(raw);
  if (!checked.ok) {
    await ctx.reply(checked.error); // остаёмся в режиме ввода — можно отправить исправленный текст
    return;
  }

  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const updated = await updateChannelLeaveTemplate(env, channel.id, checked.template);
  const view = buildModerationView(updated ?? channel);
  await ctx.reply(`✅ Текст уведомления о выходе обновлён.\n\n${view.text}`, { reply_markup: view.kb });
}

async function handleAntilinkWhitelistInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const raw = ctx.message?.text;
  if (!raw || raw.trim() === "") return;

  const channel = await getOwnedChannel(ctx, env, data.channel_id);
  if (!channel) {
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    await ctx.reply("Этот чат не найден в ваших настройках (возможно, бота уже убрали из группы). Начните с /settings.");
    return;
  }

  const result = addWhitelistEntries(resolveAntilinkWhitelist(channel.antilink_whitelist), raw);
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  const updated =
    result.added.length > 0
      ? ((await updateChannelAntilinkWhitelist(env, channel.id, serializeAntilinkWhitelist(result.whitelist))) ?? channel)
      : channel;

  // Та же причина разделения отчёта и полного списка на два отдельных
  // сообщения, что и в handleSpamPhrasesInput выше — см. её комментарий.
  const lines: string[] = [];
  if (result.added.length > 0) lines.push(`✅ Добавлено доменов: ${result.added.length}`, ...bulletLines(result.added));
  else lines.push("Ничего не добавлено.");
  if (result.skipped.length > 0) {
    lines.push(
      "",
      "Пропущено:",
      ...bulletLines(result.skipped.map((s) => `«${truncateLabel(s.input, 40)}» — ${describeWhitelistSkipReason(s)}`)),
    );
  }
  await ctx.reply(lines.join("\n"));

  const view = buildAntilinkWhitelistView(updated, 0);
  await ctx.reply(view.text, { reply_markup: view.kb });
}
