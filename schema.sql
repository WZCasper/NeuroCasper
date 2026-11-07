-- NeuroCasper D1 schema
-- Apply with:
--   npx wrangler d1 execute neurocasper-db --local  --file=./schema.sql
--   npx wrangler d1 execute neurocasper-db --remote --file=./schema.sql
--
-- Safe to re-run: drops and recreates everything. Fine while there's no
-- real user data yet; once this is live, switch to additive migrations
-- instead of touching this file directly.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS cod_onboarding_progress;
DROP TABLE IF EXISTS cod_authorizations;
DROP TABLE IF EXISTS activision_session;
DROP TABLE IF EXISTS pending_message_deletions;
DROP TABLE IF EXISTS user_reports;
DROP TABLE IF EXISTS post_claims;
DROP TABLE IF EXISTS post_platforms;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS extra_links;
DROP TABLE IF EXISTS kick_oauth_states;
DROP TABLE IF EXISTS kick_tokens;
DROP TABLE IF EXISTS social_accounts;
DROP TABLE IF EXISTS streamers;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS twitch_token;

-- Telegram users who have talked to the bot. `session_state` backs the
-- multi-step /add_channel, /add_social and /settings text-input flows
-- (JSON blob: {"step": "...", "data": {...}}), since Workers are stateless
-- between requests and can't hold conversation state in memory.
CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id  INTEGER NOT NULL UNIQUE,
  username          TEXT,
  first_name        TEXT,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  session_state     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Destination Telegram channels/groups. A row is created by an admin
-- running /add_channel *inside* the target chat (verified via
-- getChatMember), not by pasting a chat ID in DM.
CREATE TABLE channels (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id  INTEGER NOT NULL,
  title             TEXT,
  message_template  TEXT NOT NULL DEFAULT '{title}',
  auto_pin          INTEGER NOT NULL DEFAULT 1,
  auto_unpin        INTEGER NOT NULL DEFAULT 1,
  -- New-member moderation, editable per chat in /settings. NULL template /
  -- phrases mean "use the built-in default" (src/lib/moderation-settings.ts).
  welcome_enabled      INTEGER NOT NULL DEFAULT 1,
  welcome_template     TEXT,
  -- Seconds until a welcome message is auto-deleted from the group; 0 means
  -- "never delete". See migrations/007_add_welcome_delete_after.sql.
  welcome_delete_after_seconds  INTEGER NOT NULL DEFAULT 600,
  spam_filter_enabled  INTEGER NOT NULL DEFAULT 1,
  spam_phrases         TEXT,
  -- Announce when a member leaves/is removed from the group (the mirror of
  -- welcome_enabled/welcome_template above, for the opposite event). NULL
  -- template means "use the built-in default". See
  -- migrations/008_add_leave_message.sql; shares
  -- welcome_delete_after_seconds for auto-deletion rather than having its
  -- own separate delay -- one delay setting for both join/leave
  -- notifications is simpler and matches what was actually asked for.
  leave_enabled        INTEGER NOT NULL DEFAULT 1,
  leave_template       TEXT,
  -- AntiLink: delete any group message whose link isn't on the whitelist
  -- below (see src/lib/antilink.ts). migrations/009_add_antilink.sql.
  -- Default 0 (OFF): unlike welcome/spam_filter, this deletes ordinary
  -- members' own messages, so every existing chat should keep its current
  -- behavior until the owner deliberately turns it on in /settings, rather
  -- than suddenly having links disappear the moment this ships.
  antilink_enabled     INTEGER NOT NULL DEFAULT 0,
  -- JSON array of whitelisted hostnames. NULL/"[]" both mean nothing is
  -- whitelisted -- there's no built-in default here (unlike spam_phrases),
  -- since which domains are legitimate is entirely chat-specific.
  antilink_whitelist   TEXT,
  -- URL blacklist: delete any group message linking to a specific
  -- blacklisted channel/page (see src/lib/antilink.ts) -- independent of
  -- antilink_enabled above, so it works even with AntiLink itself off.
  -- migrations/010_add_url_blacklist.sql. Default 0 (OFF), for the same
  -- reason antilink_enabled defaults to 0 -- this also deletes ordinary
  -- members' own messages.
  url_blacklist_enabled INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {hostname, path, display} entries. NULL/"[]" both mean
  -- nothing is blacklisted -- no built-in default here either.
  url_blacklist         TEXT,
  -- Delete Telegram's OWN service message announcing a member joined/left
  -- (message.new_chat_members / message.left_chat_member) -- this is the
  -- grey "X joined the group" / "X left the group" line Telegram itself
  -- inserts into the chat, completely separate from welcome_enabled/
  -- leave_enabled above, which are this bot's OWN announcement text. A
  -- chat can have either, both, or neither turned on independently: hide
  -- Telegram's own line while keeping the bot's own welcome/leave message,
  -- or vice versa. Default 0 (OFF) -- unlike the delete-on-sight AntiLink
  -- features, this has no safety reason to default off, but matching
  -- welcome_enabled/leave_enabled's default of 1 risks deleting a message
  -- type with special Telegram semantics (e.g. a NEW member's very first
  -- message in some client flows IS the join service message) for every
  -- existing chat the moment this ships, without the owner having asked
  -- for it -- an explicit opt-in is the safer default for a brand-new
  -- feature nobody has configured yet. See migrations/011_add_hide_service_messages.sql.
  hide_service_messages INTEGER NOT NULL DEFAULT 0,
  -- Ежедневная сводка по играм авторизованных участников (см.
  -- cod_authorizations выше, src/lib/cod-client.ts,
  -- src/scheduled-cod-summary.ts). Default 0 (OFF) -- новая функция,
  -- никто её ещё не настраивал, плюс она зависит от
  -- activision_session, которой изначально вообще нет ни одной строки.
  cod_summary_enabled   INTEGER NOT NULL DEFAULT 0,
  -- Код игры, передаваемый в запрос статистики Call of Duty API
  -- (src/lib/cod-client.ts) -- НАСТРАИВАЕМЫЙ, а не захардкоженный в коде,
  -- потому что на момент этой миграции (конец 2026) точный код для
  -- актуальных игр (Black Ops 7, Modern Warfare 4) НЕ подтверждён ни в
  -- одном открытом источнике -- только исторические коды для игр
  -- 2017-2020 (mw, cw, bo3, bo4, wwii, iw) задокументированы где-либо.
  -- NULL -- используется разумное предположение по умолчанию
  -- (DEFAULT_COD_TITLE_CODE в cod-client.ts), которое владелец должен
  -- проверить и при необходимости поменять здесь на подтверждённый код,
  -- когда таковой станет известен, без единой правки в самом коде бота.
  cod_title_code        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_user_id, telegram_chat_id)
);

-- A real-world streamer/creator tracked for a destination channel. Groups
-- one or more *monitored* platform accounts (YouTube/TikTok) that belong to
-- the same person, so simultaneous activity across platforms posts as ONE
-- Telegram message with one button per platform instead of duplicate
-- messages. See extra_links below for platforms that aren't monitored but
-- should still get a button (this is where Twitch lives now).
CREATE TABLE streamers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One *monitored* platform account belonging to a streamer — the bot
-- actively checks these for live/new-video activity.
CREATE TABLE social_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id         INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','kick')),
  platform_user_id    TEXT,   -- YouTube channel ID (UC...) / Kick broadcaster_user_id; unused for tiktok
  platform_username   TEXT NOT NULL,
  last_video_id       TEXT,   -- last seen video/room id, for de-duping
  last_checked_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(streamer_id, platform)
);

-- One row per Kick channel the bot has been authorized for. Unlike YouTube
-- (public RSS feed) and TikTok (public profile page), Kick's events:subscribe
-- webhook is per-authorized-user: the broadcaster (the streamer themself,
-- not whoever runs this bot) must complete Kick's OAuth flow once so the
-- bot can subscribe to their livestream.status.updated event. See
-- src/lib/kick.ts for the OAuth + webhook-subscribe flow that fills this.
CREATE TABLE kick_tokens (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  social_account_id     INTEGER NOT NULL UNIQUE REFERENCES social_accounts(id) ON DELETE CASCADE,
  broadcaster_user_id   INTEGER NOT NULL,
  access_token          TEXT NOT NULL,
  refresh_token         TEXT NOT NULL,
  expires_at            TEXT NOT NULL,  -- ISO datetime; refresh before this
  event_subscription_id TEXT,           -- Kick's id for the livestream.status.updated subscription, for cleanup
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived CSRF-protection row for Kick's OAuth flow: created right
-- before redirecting the streamer to Kick's authorization page, read back
-- (and deleted) when Kick redirects back to /kick/oauth/callback with this
-- same `state` value. Ties the callback to the streamer_id and the
-- Telegram user who started the flow, since the OAuth round trip happens
-- in the streamer's own browser, outside any Telegram session. Also carries
-- the PKCE code_verifier generated alongside `state`, since the token
-- exchange at the callback step needs the exact same value used to derive
-- the code_challenge in the authorization URL. Rows older than a few
-- minutes are treated as expired regardless of whether they're deleted
-- (see src/lib/kick.ts).
CREATE TABLE kick_oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  streamer_id   INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A static link attached to a streamer that ISN'T independently monitored
-- (Twitch — dropped as a monitored platform since registering a Twitch app
-- needs 2FA the streamer couldn't enable — or anything else: Discord,
-- Instagram, a second channel, etc). Shown as an extra button on every
-- alert for that streamer, live or video, regardless of which monitored
-- platform actually triggered the post. This is a deliberate trade: no
-- verification that e.g. Twitch is *actually* live at that moment, just an
-- assumption that a simulcasting streamer is live everywhere they usually
-- are whenever any one of their monitored platforms is.
CREATE TABLE extra_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id   INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,   -- e.g. "Twitch", "Discord"
  url           TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One posted Telegram message representing a streamer's "live now" session
-- or "new video" announcement. `kind` decides how it can be merged: a
-- 'live' post stays open for merging for as long as is_open=1 (i.e. for as
-- long as at least one monitored platform under it is still live); a
-- 'video' post is only open for merging for a short time window after
-- creation (see VIDEO_POST_MERGE_WINDOW_MINUTES in src/db.ts /
-- scripts/lib/db.ts), since uploads don't have a natural "end" event.
CREATE TABLE posts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id          INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  channel_id           INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('live','video')),
  telegram_chat_id     INTEGER NOT NULL,
  telegram_message_id  INTEGER NOT NULL,
  is_open              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at            TEXT
);

-- One row per *monitored* platform folded into a post. A single-platform
-- stream has one row; a YouTube+TikTok simulcast has two rows under the
-- same post_id. extra_links are NOT rows here — they're appended to the
-- button list at send time without being tracked as "live sessions" (see
-- src/lib/publish.ts).
CREATE TABLE post_platforms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id   INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  content_id          TEXT,     -- YouTube video id / TikTok item id
  url                 TEXT NOT NULL,
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, social_account_id)
);

-- Short-lived claim used ONLY to serialize "create the brand-new first post
-- for this streamer+kind" across CONCURRENT WORKER INVOCATIONS -- the race
-- an in-memory lock can't reach (a same-invocation race, e.g. one streamer
-- tracked on both YouTube and TikTok going live in the same cron run, is
-- already prevented in-memory by src/lib/streamer-serializer.ts before any
-- of this is touched). This table exists for the case that IS a genuinely
-- separate invocation: a Kick webhook (its own HTTP request, see
-- src/handlers/kick.ts) landing while the cron's scheduled() run
-- (src/scheduled.ts) is concurrently deciding the same thing for the same
-- streamer, or two overlapping cron runs.
--
-- A row here means "some request is currently in the middle of creating a
-- new post for this streamer+kind" -- NOT "a post is open" (posts.is_open
-- / the video merge-window check are unaffected and still answer that).
-- src/db.ts's claimPostSlot INSERTs a row before src/lib/publish.ts's
-- publishOrMerge sends the Telegram message; the INSERT either succeeds
-- (caller proceeds) or fails on the PRIMARY KEY (caller backs off and
-- retries publishOrMerge from the top, which will by then very likely find
-- the winner's freshly-created open post via findOpenPost and merge into
-- it instead of sending its own message). releasePostSlot deletes the row
-- right after, success or failure -- claimed_at exists purely so a request
-- killed mid-flight (Worker CPU/wall-clock limit, uncaught crash) before
-- it can release its own claim doesn't wedge this streamer+kind out of
-- ever getting a new post again: claimPostSlot treats a claim older than
-- POST_CLAIM_STALE_AFTER_SECONDS (src/db.ts) as abandoned and steals it.
CREATE TABLE post_claims (
  streamer_id  INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('live','video')),
  claimed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (streamer_id, kind)
);

CREATE INDEX idx_channels_owner       ON channels(owner_user_id);
CREATE INDEX idx_streamers_channel    ON streamers(channel_id);
CREATE INDEX idx_social_streamer      ON social_accounts(streamer_id);
CREATE INDEX idx_social_platform      ON social_accounts(platform);
CREATE INDEX idx_kick_tokens_broadcaster ON kick_tokens(broadcaster_user_id);
CREATE INDEX idx_extra_links_streamer ON extra_links(streamer_id);
CREATE INDEX idx_posts_streamer_open  ON posts(streamer_id, kind, is_open);

-- At most one OPEN 'live' post per streamer -- a database-level backstop
-- against ever ending up with two, on top of (not instead of) the
-- post_claims-based fix above that actually prevents the race in normal
-- operation: post_claims stops a second "create a new post" attempt for
-- the same streamer+kind before it ever calls the Telegram API, so this
-- index is not expected to fire in practice anymore. It stays as a second
-- line of defence -- if something ever bypasses claimPostSlot (a future
-- code path that calls createPost directly, a bug in the claim/retry
-- logic), this still makes the resulting duplicate INSERT fail loudly
-- (caught and logged in publishOrMerge) instead of silently succeeding as
-- two independently-tracked posts, only one of which would ever receive
-- further button updates or auto-unpin. Partial index, so closed posts and
-- 'video' posts (which use a time-window check instead of is_open, see
-- VIDEO_POST_MERGE_WINDOW_MINUTES) are unaffected.
CREATE UNIQUE INDEX idx_posts_one_open_live_per_streamer
  ON posts(streamer_id) WHERE kind = 'live' AND is_open = 1;

CREATE INDEX idx_post_platforms_post  ON post_platforms(post_id, ended);
CREATE INDEX idx_post_platforms_acct  ON post_platforms(social_account_id, ended);

-- Backs the /report command and the auto-ban-after-2-reports behavior.
-- Deliberately not foreign-keyed to channels/streamers/users -- a
-- reported person, whoever reports them, and the chat a report came from
-- are all arbitrary Telegram entities, not necessarily anyone who has
-- registered anything with /start or /add_channel. See
-- migrations/004_add_user_reports.sql for the full rationale, in
-- particular why UNIQUE(reported_user_id, chat_telegram_id) is the actual
-- mechanism preventing several members of ONE group from colluding to hit
-- the global ban threshold on their own.
CREATE TABLE user_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_user_id  INTEGER NOT NULL,
  reporter_user_id  INTEGER NOT NULL,
  chat_telegram_id  INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reported_user_id, chat_telegram_id)
);

CREATE INDEX idx_user_reports_reported ON user_reports (reported_user_id);

-- A Telegram message (currently only welcome messages, see
-- channels.welcome_delete_after_seconds) queued for deletion once delete_at
-- has passed. delete_at is an ABSOLUTE timestamp computed once at send time;
-- storing the delay and recomputing "now + delay" on each cron sweep would
-- push the deletion further away forever. See
-- migrations/007_add_welcome_delete_after.sql.
CREATE TABLE pending_message_deletions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id  INTEGER NOT NULL,
  message_id        INTEGER NOT NULL,
  delete_at         TEXT NOT NULL
);

CREATE INDEX idx_pending_message_deletions_delete_at ON pending_message_deletions (delete_at);

-- Один участник группы, прошедший «авторизацию» в этой группе: назвал
-- отображаемое имя и свой Activision-тег в ответ на 2 вопроса при
-- вступлении (см. src/lib/cod-onboarding.ts). Хранится НАВСЕГДА, как и
-- попросил владелец -- ничего здесь само не удаляется и не истекает;
-- единственный способ убрать запись -- владелец или сам участник явно
-- просит об этом. UNIQUE(channel_id, telegram_user_id): один и тот же
-- человек авторизуется один раз на канал/группу, повторная попытка
-- обновляет уже существующую запись (см. upsertCodAuthorization в db.ts),
-- а не плодит дубликаты. ПОЛНОСТЬЮ независимо от games played — тег
-- запоминается сам по себе, даже если Activision Sportsman/активность по
-- нему потом окажется недоступна боту (см. activision_session ниже и
-- channels.cod_summary_enabled/cod_title_code).
CREATE TABLE cod_authorizations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER NOT NULL,
  -- Ответ на вопрос 1 («Как ваше имя?») -- произвольный текст, который
  -- участник ввёл сам, НЕ обязательно его Telegram-имя.
  display_name      TEXT NOT NULL,
  -- Ответ на вопрос 2 -- Activision-тег, пример формата дан самим
  -- владельцем боту: «亗 Casper#7378333». Хранится ровно как ввёл
  -- участник, без нормализации регистра/пробелов -- именно так он будет
  -- показан в ежедневной сводке, и именно так он будет передан боту для
  -- поиска статистики, когда это станет возможным технически (см.
  -- activision_session и cod-client.ts -- на момент этой миграции сам
  -- код игры для Black Ops 7/Modern Warfare 4 ещё не подтверждён, но тег
  -- запоминается уже сейчас, независимо от этого).
  activision_tag    TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, telegram_user_id)
);

-- Служебная сессия СОБСТВЕННОГО Activision-аккаунта бота (не аккаунта
-- какого-либо участника группы) -- единственная на весь бот, не
-- привязана к конкретному channel_id/streamer_id. Ровно ОДНА строка
-- когда-либо существует (id всегда 1 -- см. upsertActivisionSession в
-- db.ts, которая делает UPSERT по этому фиксированному id, а не INSERT
-- новой строки на каждое обновление). Эта таблица, а не Worker Secrets,
-- потому что cookie_value должна обновляться ЧЕРЕЗ /settings самим
-- владельцем, а Worker Secrets можно менять только через
-- `wrangler secret put`/дашборд Cloudflare, не из кода бота.
--
-- cookie_value -- ЕДИНСТВЕННЫЙ способ входа, который реально
-- используется кодом (см. src/lib/cod-session.ts): для пути
-- my.callofduty.com, нужного классическому Warzone, программного входа
-- по email+паролю не существует вообще ни в каком виде -- это
-- подтверждено разбором единственной работающей reference-реализации, а
-- не предположение. Это ACT_SSO_COOKIE, добытая ВРУЧНУЮ из браузера (см.
-- src/lib/cod-client.ts), обновляется владельцем вручную по мере
-- истечения -- истечение здесь не отслеживается заранее, бот просто
-- пробует cookie_value при каждом обращении и обнаруживает её
-- непригодность по ответу самого Activision (см. CodApiError в
-- cod-client.ts). email/password хранятся ВПРОК, на случай будущей
-- отдельной интеграции с другим API (telescope-путь для Warzone2/
-- MW2/MW3, который ДЕЙСТВИТЕЛЬНО поддерживает пароль, но для ДРУГИХ
-- игр) -- владелец явно решил не делать эту интеграцию сейчас, так что
-- сегодняшний код (cod-session.ts) эти два поля не читает вообще.
CREATE TABLE activision_session (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  email         TEXT,
  password      TEXT,
  cookie_value  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Черновик «авторизации» ОДНОГО участника в ОДНОЙ группе, пока он отвечает
-- на 2 вопроса (см. src/lib/cod-onboarding.ts) -- существует только МЕЖДУ
-- вопросом 1 и финальным ответом на вопрос 2; как только оба ответа
-- получены, из этой строки собирается настоящая cod_authorizations (см.
-- upsertCodAuthorization в db.ts) и сама строка здесь удаляется. Отдельная
-- таблица, а не поле прямо в cod_authorizations -- cod_authorizations
-- хранит данные НАВСЕГДА и обе её текстовые колонки NOT NULL ровно
-- потому, что это завершённая, осмысленная запись; недописанный черновик
-- с display_name = NULL был бы грязью в той же таблице. UNIQUE
-- (channel_id, telegram_user_id): участник отвечает на один и тот же
-- набор вопросов за раз -- если бот прислал вопрос 1 повторно (например,
-- после перезапуска чего-либо), более новая попытка просто заменяет
-- прежнюю, а не плодит вторую параллельную.
CREATE TABLE cod_onboarding_progress (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER NOT NULL,
  -- "awaiting_name" -- ждём ответ на вопрос 1. "awaiting_tag" -- вопрос 1
  -- получен (см. display_name ниже), ждём ответ на вопрос 2.
  step              TEXT NOT NULL CHECK (step IN ('awaiting_name', 'awaiting_tag')),
  -- Заполняется, когда step переходит в 'awaiting_tag'; NULL, пока ждём
  -- ещё самого первого ответа.
  display_name      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, telegram_user_id)
);
