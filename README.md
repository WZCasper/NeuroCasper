# NeuroCasper

Telegram bot that watches Twitch/YouTube/TikTok streamers and posts a
"live now" or "new video" alert to a Telegram channel or group — one
button per platform, merged into a single message if a streamer is live
on more than one platform at once.

## How it's built

- **Cloudflare Worker** (`src/`) — the bot itself (grammY) and the Twitch
  EventSub webhook. Real-time: Twitch pushes a webhook the moment someone
  goes live.
- **Cloudflare D1** (`schema.sql`) — users, channels, streamers, platform
  accounts, and the posted-message state.
- **GitHub Actions** — runs the recurring YouTube/TikTok checker on a cron,
  since that needs somewhere to live independent of the Worker. The Worker
  itself is deployed by Cloudflare's own Git integration (connect the repo
  in the dashboard, it builds and deploys on every push) rather than a
  custom Actions workflow — simpler, and Cloudflare's own build system
  already has the credentials it needs. See "Deploy" below for exactly
  which parts are automatic and which one-time steps only you can do
  (creating accounts/apps requires authenticating as *you* on
  Cloudflare/Telegram/Twitch/GitHub — not something to hand an assistant).

`src/lib/publish.ts` and `scripts/lib/publish.ts` implement the same
"post or merge" rule in both places: if a streamer's platform goes live (or
publishes a new video) while another platform for the *same* streamer
already has an open post, the new platform's button is added to that post
instead of sending a second message. A platform's button is removed when it
ends; the post is unpinned and closed once every platform under it has ended.

## Deploy

Two independent things get deployed here, on two different schedules: **the
Worker** (deployed by Cloudflare's own Git integration, triggered by pushes
to `main`) and **the checker** (runs on a cron, so it needs somewhere to
live regardless of how the Worker gets deployed — that's GitHub Actions).

### 0. One-time accounts/credentials

- Telegram bot token: message [@BotFather](https://t.me/BotFather) → `/newbot`
- Cloudflare account (Workers + D1 are free tier) — note your **Account ID**
  (dashboard right sidebar) and your **workers.dev subdomain** (Workers &
  Pages → Overview)
- Cloudflare API token (only needed for the checker's GitHub Actions
  secrets below, not for the Worker itself): dashboard → My Profile → API
  Tokens → Create Token → permissions **Account.D1: Edit**
- Twitch app: [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
  → Register → any name, redirect URL `https://localhost`, category
  "Application Integration" → copy Client ID, generate Client Secret.
  **Registering requires 2FA on your Twitch account**, which needs a phone
  number for the initial SMS step — if that doesn't work for your number,
  see the note in Limitations below. Skippable: the bot works fine with
  only YouTube/TikTok if Twitch isn't available to you.
- (Optional) YouTube Data API v3 key: [console.cloud.google.com](https://console.cloud.google.com)
  → enable the API → Credentials → API key — without this, YouTube live
  detection falls back to a best-effort page check (see Limitations)

None of these can be created by an assistant on your behalf — each one is
tied to proving it's *you* on that platform.

### 1. Repo

Push the code to a GitHub repo you control (see git log for how this one
got there). Cloudflare's Git integration and GitHub Actions both read from
this repo directly, on every push to `main`.

### 2. The Worker — Cloudflare's Git integration

Workers & Pages → your Worker → connected to this repo, with:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Cloudflare builds and deploys on every push using its own internal auth —
no GitHub secrets needed for this part. What's still needed, one time:

- **D1 database**: Storage & databases → D1 → Create database → paste the
  id into `wrangler.toml`'s `database_id` (replacing the placeholder),
  commit, push. (`.github/workflows/1-bootstrap-db.yml` does the same
  creation step from the Actions tab instead, if you'd rather not use the
  dashboard for this one part — either way produces the same kind of
  database, use whichever's convenient.)
- **`WORKER_URL`** in `wrangler.toml`'s `[vars]` — your actual
  `https://<worker-name>.<subdomain>.workers.dev`.
- **Secrets**: this Worker's own **Settings → Variables and Secrets** tab
  → Add → type **Secret** → one each for `BOT_TOKEN`, `WEBHOOK_SECRET`,
  `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`
  (skip the three Twitch ones if you're not using Twitch). These attach to
  the Worker immediately — no redeploy needed, and they're separate from
  GitHub Secrets entirely.

Each push after that just redeploys; the schema migration
(`npx wrangler d1 execute ... --remote --file=./schema.sql`) only needs
running once after the database is created — from your machine, or via
`workflow_dispatch` on `1-bootstrap-db.yml` adapted to run it, or by hand
in the dashboard's D1 console.

### 3. Point Telegram at the Worker

Once deployed and `BOT_TOKEN`/`WEBHOOK_SECRET` are set on the Worker,
either run `.github/workflows/2-set-webhook.yml` manually from the Actions
tab (this one needs `BOT_TOKEN` and `WEBHOOK_SECRET` added as *repo*
secrets too, since it runs on GitHub, not Cloudflare — Settings → Secrets
and variables → Actions), or just run this once, from anywhere:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<WORKER_URL>/webhook/telegram" \
  --data-urlencode "secret_token=<WEBHOOK_SECRET>"
```

### 4. The checker (YouTube/TikTok) — GitHub Actions, always

This part runs on a schedule regardless of how the Worker is deployed, so
it needs its own repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | step 0 |
| `CLOUDFLARE_API_TOKEN` | step 0 |
| `CLOUDFLARE_D1_DATABASE_ID` | same id as step 2 |
| `BOT_TOKEN` | same token as step 2 |
| `YOUTUBE_API_KEY` | optional, step 0 |

`.github/workflows/3-checker.yml` then runs every 5 minutes on its own —
no further action needed.

## Known limitations (read before relying on this)

- **Telegram inline buttons have no color setting** — the Bot API doesn't
  expose one, so "red/purple/black buttons" isn't literally achievable.
  What's shipped: a colored emoji circle in the button label (🔴 YouTube /
  🟣 Twitch / ⚫ TikTok). Full color control *is* available for the
  generated fallback preview image, since that's pixels the bot draws
  itself — see `src/lib/preview-image.ts`.
- **Twitch requires 2FA on your account to register a developer app**,
  and enabling 2FA requires an initial SMS to a phone number — if that SMS
  doesn't reliably reach your number, Twitch's own docs describe an
  account-signup path that defers the phone step in favor of email +
  authenticator-app (TOTP) enrollment; whether that's still open to an
  *existing* account trying to add 2FA (rather than at signup) isn't
  something this README can promise — Twitch support is the reliable next
  step if the app-based path doesn't come up. None of this blocks the rest
  of the bot: Twitch is entirely optional per streamer, and skipping it
  needs zero code changes — just never set the three `TWITCH_*` secrets
  and never pick Twitch in `/add_social`.
- **YouTube live detection without `YOUTUBE_API_KEY`** is a best-effort regex
  check on the watch page's embedded state, not an official signal. Set
  `YOUTUBE_API_KEY` for a reliable `liveBroadcastContent` check instead.
- **TikTok has no public API at all** for live status or a channel's videos.
  `scripts/lib/tiktok.ts` scrapes the public profile page for a `roomId`
  marker and the newest video link. It fails closed (reports "not live, no
  new video") rather than erroring if TikTok's markup changes, but it *can*
  silently stop finding anything — treat TikTok as the least reliable of
  the three platforms. TikTok posts also won't have a title (no reliable
  way to extract one without an API), so they show just the streamer-name
  header.
- **The checker's GitHub Actions secrets are separate from the Worker's
  Cloudflare-dashboard secrets** — the same underlying value (e.g.
  `BOT_TOKEN`) has to be entered in both places, since the two run in
  different systems that don't share a secret store.
- **Not network-tested against the real Telegram/Twitch/YouTube/TikTok
  APIs** during the build of this project — that sandbox only had access
  to package registries. What *was* verified: the Worker's own logic
  (routing, Twitch webhook HMAC verification, the challenge/response flow,
  background-processing pattern) against a real local Cloudflare Workers
  runtime (`wrangler dev`), and the fallback preview-image renderer against
  real rendered PNG output (visually inspected, including catching and
  fixing a font-glyph bug). Do a real test after step 3 above (send
  `/start`, add a real streamer, trigger "3) checker" manually) before
  trusting it unattended.

## Using the bot

- `/start` — overview
- In a **group**: `/add_channel` (bot must already be admin there)
- For a **channel**: forward any post from it to the bot in DM (bot must
  already be admin there)
- In DM: `/add_social` — pick the channel, then an existing or new
  streamer, then a platform, then send the username
- In DM: `/settings` — toggle auto-pin/auto-unpin, edit the alert text
  (`{title}` `{game}` placeholders), see attached streamers

## Local development (optional — not required for deployment)

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real or throwaway test values
npm run db:migrate:local
npx wrangler dev
npm run typecheck                 # both the Worker and the checker script
npm run check                     # run the checker script once, locally
```
