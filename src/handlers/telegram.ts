import { Bot, Context, InlineKeyboard } from "grammy";
import {
  createChannel,
  createSocialAccount,
  createStreamer,
  getChannelById,
  getChannelByOwnerAndChatId,
  listChannelsByOwner,
  listSocialAccountsByStreamer,
  listStreamersByChannel,
  setSession,
  toggleChannelFlag,
  updateChannelTemplate,
} from "../db.js";
import { DEFAULT_TEMPLATE } from "../lib/message-templates.js";
import { getTwitchUserByLogin, subscribeEventSub } from "../lib/twitch-api.js";
import { IDLE_SESSION } from "../types.js";
import type { ChannelRow, Env, Platform, SessionState, UserRow } from "../types.js";

export interface BotContext extends Context {
  dbUser: UserRow;
  session: SessionState;
}

const ALL_PLATFORMS: Platform[] = ["twitch", "youtube", "tiktok"];
const PLATFORM_DISPLAY: Record<Platform, string> = { twitch: "Twitch", youtube: "YouTube", tiktok: "TikTok" };

export function registerHandlers(bot: Bot<BotContext>, env: Env): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "NeuroCasper watches Twitch/YouTube/TikTok streamers and posts a “live” or “new video” alert " +
        "to your Telegram channel or group, with a button per platform.\n\n" +
        "Setup:\n" +
        "1) Add me as admin (with the “pin messages” permission) to your channel or group.\n" +
        "2) Register it:\n" +
        "   • Group: send /add_channel inside the group.\n" +
        "   • Channel: forward any post from the channel to me here in DM.\n" +
        "3) Back in this DM, send /add_social to attach a streamer.\n" +
        "4) Use /settings any time to edit the alert template or pin behaviour.\n\n" +
        "If the same streamer is live on more than one platform at once, I merge it into a single message " +
        "with one button per platform instead of posting twice.",
    );
  });

  bot.command("add_channel", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === "private") {
      await ctx.reply(
        "Run /add_channel inside the group you want alerts posted to — or, for a broadcast channel, forward any post from that channel to me here.",
      );
      return;
    }
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await ctx.reply("This only works in groups/supergroups. For channels, forward a post to me in DM.");
      return;
    }
    if (!ctx.from) return;

    const botMember = await ctx.getChatMember(ctx.me.id).catch(() => null);
    if (!botMember || botMember.status !== "administrator") {
      await ctx.reply(
        "Please make me an admin here first (post + pin messages permission), then run /add_channel again.",
      );
      return;
    }

    const userMember = await ctx.getChatMember(ctx.from.id).catch(() => null);
    if (!userMember || (userMember.status !== "creator" && userMember.status !== "administrator")) {
      await ctx.reply("Only an admin of this group can register it.");
      return;
    }

    const existing = await getChannelByOwnerAndChatId(env, ctx.dbUser.id, chat.id);
    if (existing) {
      await ctx.reply("This group is already registered. DM me /add_social to attach a streamer.");
      return;
    }

    await createChannel(env, ctx.dbUser.id, chat.id, chat.title);
    await ctx.reply("✅ Registered! DM me /add_social to attach a Twitch, YouTube or TikTok streamer.");
  });

  bot.command("add_social", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please DM me to add a streamer — groups/channels stay alert-only.");
      return;
    }
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    if (channels.length === 0) {
      await ctx.reply("You haven't registered a channel or group yet — see /start for how.");
      return;
    }
    const only = channels.length === 1 ? channels[0] : undefined;
    if (only) await promptStreamerChoice(ctx, env, only, false);
    else await promptChannelChoice(ctx, channels, "soc");
  });

  bot.command("settings", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please DM me to change settings.");
      return;
    }
    await setSession(env, ctx.dbUser.id, IDLE_SESSION);
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    if (channels.length === 0) {
      await ctx.reply("You haven't registered a channel or group yet — see /start for how.");
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
    } else if (session.step === "awaiting_template") {
      await handleTemplateInput(ctx, env, session.data);
    }
  });
}

// ---------------------------------------------------------------------------
// Channel registration via forwarded post (for broadcast channels)
// ---------------------------------------------------------------------------

async function registerChannelFromForward(ctx: BotContext, env: Env): Promise<void> {
  const origin = ctx.message?.forward_origin;
  if (!origin || origin.type !== "channel" || !ctx.from) return;
  const channelChat = origin.chat;

  const botMember = await ctx.api.getChatMember(channelChat.id, ctx.me.id).catch(() => null);
  if (!botMember || botMember.status !== "administrator") {
    await ctx.reply(
      "I'm not an admin of that channel yet. Add me as admin (post + pin messages permission), then forward the post again.",
    );
    return;
  }

  const userMember = await ctx.api.getChatMember(channelChat.id, ctx.from.id).catch(() => null);
  if (!userMember || (userMember.status !== "creator" && userMember.status !== "administrator")) {
    await ctx.reply("Only an admin of that channel can register it.");
    return;
  }

  const existing = await getChannelByOwnerAndChatId(env, ctx.dbUser.id, channelChat.id);
  if (existing) {
    await ctx.reply("That channel is already registered. Send /add_social to attach a streamer.");
    return;
  }

  await createChannel(env, ctx.dbUser.id, channelChat.id, channelChat.title);
  await ctx.reply(
    `✅ "${channelChat.title}" registered! Send /add_social to attach a Twitch, YouTube or TikTok streamer.`,
  );
}

// ---------------------------------------------------------------------------
// /add_social flow: channel -> streamer (existing or new) -> platform -> username
// ---------------------------------------------------------------------------

async function promptChannelChoice(ctx: BotContext, channels: ChannelRow[], prefix: "soc" | "set"): Promise<void> {
  const kb = new InlineKeyboard();
  for (const ch of channels) {
    kb.text(ch.title ?? String(ch.telegram_chat_id), `${prefix}:ch:${ch.id}`).row();
  }
  await ctx.reply("Which channel/group?", { reply_markup: kb });
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
  kb.text("➕ New streamer", `soc:newstr:${channel.id}`).row();
  const text = `Streamer for "${channel.title ?? channel.telegram_chat_id}":`;
  if (edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
}

async function promptPlatformChoice(
  ctx: BotContext,
  env: Env,
  streamerId: number,
  edit: boolean,
): Promise<void> {
  const existing = await listSocialAccountsByStreamer(env, streamerId);
  const taken = new Set(existing.map((a) => a.platform));
  const remaining = ALL_PLATFORMS.filter((p) => !taken.has(p));

  if (remaining.length === 0) {
    const text = "All three platforms are already attached to this streamer.";
    if (edit) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }

  const kb = new InlineKeyboard();
  for (const p of remaining) kb.text(PLATFORM_DISPLAY[p], `soc:pl:${streamerId}:${p}`).row();
  const text = "Which platform?";
  if (edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
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
    await ctx.editMessageText('What’s this streamer’s name? (shown in alerts, e.g. "Alex")');
    return;
  }

  if (action === "str" && rest[1]) {
    await promptPlatformChoice(ctx, env, Number(rest[1]), true);
    return;
  }

  if (action === "pl" && rest[1] && rest[2]) {
    const streamerId = Number(rest[1]);
    const platform = rest[2] as Platform;
    await setSession(env, ctx.dbUser.id, {
      step: "awaiting_social_username",
      data: { streamer_id: streamerId, platform },
    });
    const hint =
      platform === "twitch"
        ? "Send their Twitch username (e.g. shroud)."
        : platform === "youtube"
          ? "Send their YouTube channel ID (starts with UC…) or @handle."
          : "Send their TikTok username (without @).";
    await ctx.editMessageText(hint);
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

  if (data.platform === "twitch") await addTwitchSocial(ctx, env, data.streamer_id, username);
  else if (data.platform === "youtube") await addYoutubeSocial(ctx, env, data.streamer_id, username);
  else await addTiktokSocial(ctx, env, data.streamer_id, username);
}

async function addTwitchSocial(ctx: BotContext, env: Env, streamerId: number, username: string): Promise<void> {
  await ctx.reply("Looking that up on Twitch…");

  let user;
  try {
    user = await getTwitchUserByLogin(env, username);
  } catch (err) {
    console.error("Twitch user lookup failed", err);
    await ctx.reply(
      "Twitch lookup failed — check TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are set correctly and try again.",
    );
    return;
  }
  if (!user) {
    await ctx.reply(`No Twitch user "${username}" found. Try again with /add_social.`);
    return;
  }

  let subId: string | null = null;
  try {
    subId = await subscribeEventSub(env, "stream.online", user.id);
    await subscribeEventSub(env, "stream.offline", user.id);
  } catch (err) {
    console.error("Twitch EventSub subscribe failed", err);
    await ctx.reply(
      "Found the user, but subscribing to Twitch EventSub failed. Verify TWITCH_EVENTSUB_SECRET and WORKER_URL are set and that the Worker is deployed and publicly reachable, then try again.",
    );
    return;
  }

  await createSocialAccount(env, streamerId, "twitch", user.login, user.id, subId);
  await ctx.reply(`✅ Twitch/${user.display_name} attached — you'll get an alert the moment they go live.`);
}

async function addYoutubeSocial(ctx: BotContext, env: Env, streamerId: number, input: string): Promise<void> {
  let channelYtId = input;

  if (!/^UC[\w-]{22}$/.test(input)) {
    await ctx.reply("Resolving that handle…");
    try {
      channelYtId = await resolveYoutubeChannelId(input);
    } catch (err) {
      console.error("YouTube handle resolution failed", err);
      await ctx.reply(
        "Couldn't resolve that handle automatically. Open the channel on youtube.com, copy the ID from the URL (starts with UC…) and send that instead.",
      );
      return;
    }
  }

  await createSocialAccount(env, streamerId, "youtube", input, channelYtId, null);
  await ctx.reply(
    `✅ YouTube channel attached (ID: ${channelYtId}). The GitHub Actions checker polls it roughly every 5 minutes.`,
  );
}

/** Best-effort: YouTube has no free public handle→channelId lookup, so this
 * scrapes the channel page HTML for the canonical channel ID. It can break if
 * YouTube changes their page markup — the reliable path is the user pasting
 * the UC… channel ID directly. */
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
  await createSocialAccount(env, streamerId, "tiktok", username, null, null);
  await ctx.reply(
    `✅ TikTok/@${username} attached. Heads up: TikTok has no public live-status API, so this relies on a best-effort page check in the checker script that can break if TikTok changes their site — treat it as less reliable than Twitch/YouTube.`,
  );
}

// ---------------------------------------------------------------------------
// /settings flow
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
      `Send the new alert text (shown under the "\u{1F534} {streamer} is live!" header).\nPlaceholders: {title} {game}\n\nDefault:\n${DEFAULT_TEMPLATE}`,
    );
    return;
  }

  if (action === "back") {
    const channels = await listChannelsByOwner(env, ctx.dbUser.id);
    const kb = new InlineKeyboard();
    for (const ch of channels) kb.text(ch.title ?? String(ch.telegram_chat_id), `set:ch:${ch.id}`).row();
    await ctx.editMessageText("Which channel/group?", { reply_markup: kb });
  }
}

async function renderChannelSettings(ctx: BotContext, env: Env, channel: ChannelRow): Promise<void> {
  const streamers = await listStreamersByChannel(env, channel.id);
  const lines: string[] = [];
  for (const s of streamers) {
    const accounts = await listSocialAccountsByStreamer(env, s.id);
    const platforms = accounts.length ? accounts.map((a) => PLATFORM_DISPLAY[a.platform]).join(", ") : "no platforms yet";
    lines.push(`• ${s.display_name}: ${platforms}`);
  }
  const list = lines.length ? lines.join("\n") : "(none yet — DM /add_social to add one)";

  const text =
    `⚙️ ${channel.title ?? channel.telegram_chat_id}\n\n` +
    `Auto-pin: ${channel.auto_pin ? "on" : "off"}\n` +
    `Auto-unpin: ${channel.auto_unpin ? "on" : "off"}\n\n` +
    `Streamers:\n${list}\n\n` +
    `Alert text:\n${channel.message_template}`;

  const kb = new InlineKeyboard()
    .text(channel.auto_pin ? "Turn auto-pin off" : "Turn auto-pin on", `set:pin:${channel.id}`)
    .row()
    .text(channel.auto_unpin ? "Turn auto-unpin off" : "Turn auto-unpin on", `set:unpin:${channel.id}`)
    .row()
    .text("Edit alert text", `set:tpl:${channel.id}`)
    .row()
    .text("⬅ Back", "set:back");

  await ctx.editMessageText(text, { reply_markup: kb });
}

async function handleTemplateInput(ctx: BotContext, env: Env, data: { channel_id: number }): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  await setSession(env, ctx.dbUser.id, IDLE_SESSION);
  await updateChannelTemplate(env, data.channel_id, text);
  await ctx.reply("✅ Alert text updated.");
}
