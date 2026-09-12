# NeuroCasper

Telegram bot that watches YouTube/TikTok streamers and posts a "live now"
or "new video" alert to a Telegram channel or group — one button per
platform, merged into a single message if a streamer is live on more than
one monitored platform at once. Each streamer can also have extra static
links (Twitch, Discord, a second channel, whatever) that show up as buttons
on every alert regardless of which platform actually triggered it — see
"Extra links" below for why that exists instead of monitoring Twitch too.

## How it's built

- **Cloudflare Worker** (`src/`) — the bot itself (grammY).
- **Cloudflare D1** (`schema.sql`) — users, channels, streamers, monitored
  platform accounts, extra links, and the posted-message state.
- **GitHub Actions** — runs the recurring YouTube/TikTok checker on a cron,
  since that needs somewhere to live independent of the Worker. The Worker
  itself is deployed by Cloudflare's own Git integration (connect the repo
  in the dashboard, it builds and deploys on every push) rather than a
  custom Actions workflow — simpler, and Cloudflare's own build system
  already has the credentials it needs.

`src/lib/publish.ts` and `scripts/lib/publish.ts` implement the same
"post or merge" rule in both places: if a streamer's platform goes live (or
publishes a new video) while another platform for the *same* streamer
already has an open post, the new platform's button is added to that post
instead of sending a second message. A platform's button is removed when it
ends; the post is unpinned and closed once every monitored platform under
it has ended. Extra links are appended to the button list every time,
independent of all that merge bookkeeping.

## Extra links (where Twitch lives now)

Twitch was originally a third monitored platform (EventSub webhook, real
push notifications) but got dropped: registering a Twitch developer app
requires 2FA on the Twitch account, which needs an SMS to a phone number,
and that isn't available to every streamer. Rather than block on it, Twitch
(and anything else — Discord, a second channel, a donation page) is now an
**extra link**: a label + URL attached to a streamer in `/add_social`, shown
as a button on *every* alert for that streamer, live or video, regardless
of which monitored platform triggered the post.

This trades accuracy for simplicity: there's no check that Twitch (or
whatever the link points to) is actually live at that moment — just the
assumption that a streamer who simulcasts is live everywhere they usually
are whenever any one of their monitored platforms is. If that assumption
doesn't hold for a given streamer, the Twitch button will sometimes be
wrong. `src/lib/buttons.ts` recognizes a handful of common labels
(twitch/discord/instagram/telegram/x/vk/boosty, case-insensitive) and gives
them a matching emoji; anything else gets a generic 🔗.

## Deploy

Two independent things get deployed here, on two different schedules: **the
Worker** (deployed by Cloudflare's own Git integration, triggered by pushes
to `main`) and **the checker** (runs on a cron, so it needs somewhere to
live regardless of how the Worker gets deployed — that's GitHub Actions).

### 0. One-time accounts/credentials

- Telegram bot token: message [@BotFather](https://t.me/BotFather) → `/newbot`
- Cloudflare account (Workers + D1 are free tier) — note your **Account ID**
  (dashboard right sidebar)
- Cloudflare API token (only needed for the checker's GitHub Actions
  secrets below, not for the Worker itself): dashboard → My Profile → API
  Tokens → Create Token → permissions **Account.D1: Edit**
- (Optional) YouTube Data API v3 key: [console.cloud.google.com](https://console.cloud.google.com)
  → enable the API → Credentials → API key — without this, YouTube live
  detection falls back to a best-effort page check (see Limitations)

None of these can be created by an assistant on your behalf — each one is
tied to proving it's *you* on that platform.

### 1. Repo

Push the code to a GitHub repo you control. Cloudflare's Git integration
and GitHub Actions both read from this repo directly, on every push to `main`.

### 2. The Worker — Cloudflare's Git integration

Workers & Pages → your Worker → connected to this repo, with:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Cloudflare builds and deploys on every push using its own internal auth —
no GitHub secrets needed for this part. What's still needed, one time:

- **D1 database + schema**: run **`.github/workflows/1-bootstrap-db.yml`**
  from the Actions tab (creates the database if it doesn't exist yet, then
  applies `schema.sql` either way — safe to re-run any time the schema
  changes, it's a full drop+recreate). First time only: copy the printed
  `database_id` into `wrangler.toml`'s `database_id`, commit, push.
  (Creating the database via the dashboard's Storage & databases → D1
  instead works too — either way produces the same kind of database — but
  you'd still need to apply `schema.sql` yourself some other way, e.g. the
  dashboard's D1 query console, since that part isn't a dashboard button.)
- **Secrets**: this Worker's own **Settings → Variables and Secrets** tab
  → Add → type **Secret** → one each for `BOT_TOKEN` and `WEBHOOK_SECRET`
  (make up any long random string for the latter). These attach to the
  Worker immediately — no redeploy needed, and they're separate from
  GitHub Secrets entirely.

Each push after that just redeploys the Worker code; re-run
`1-bootstrap-db.yml` separately whenever `schema.sql` itself changes.

### 3. Point Telegram at the Worker

Once deployed and `BOT_TOKEN`/`WEBHOOK_SECRET` are set on the Worker,
either run `.github/workflows/2-set-webhook.yml` manually from the Actions
tab (needs `BOT_TOKEN` and `WEBHOOK_SECRET` added as *repo* secrets too,
since it runs on GitHub, not Cloudflare — Settings → Secrets and variables
→ Actions), or just run this once, from anywhere:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://<worker-name>.<subdomain>.workers.dev/webhook/telegram" \
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
  expose one, so "coloured buttons" isn't literally achievable. What's
  shipped: a coloured emoji circle in the button label (🔴 YouTube / ⚫
  TikTok / 🟣 Twitch as an extra link). Full colour control *is* available
  for the generated fallback preview image, since that's pixels the bot
  draws itself — see `src/lib/preview-image.ts`.
- **Extra links (Twitch et al.) are never verified** — see "Extra links"
  above. The button always shows on every alert for that streamer; there's
  no check it's accurate at that exact moment.
- **YouTube live detection without `YOUTUBE_API_KEY`** is a best-effort regex
  check on the watch page's embedded state, not an official signal. Set
  `YOUTUBE_API_KEY` for a reliable `liveBroadcastContent` check instead.
- **TikTok has no public API at all** for live status or a channel's videos.
  `scripts/lib/tiktok.ts` scrapes the public profile page for a `roomId`
  marker and the newest video link. It fails closed (reports "not live, no
  new video") rather than erroring if TikTok's markup changes, but it *can*
  silently stop finding anything — treat TikTok as the least reliable
  monitored platform. TikTok posts also won't have a title (no reliable way
  to extract one without an API), so they show just the streamer-name header.
- **The checker's GitHub Actions secrets are separate from the Worker's
  Cloudflare-dashboard secrets** — the same underlying value (e.g.
  `BOT_TOKEN`) has to be entered in both places, since the two run in
  different systems that don't share a secret store.
- **Not network-tested against the real Telegram/YouTube/TikTok APIs**
  during the build of this project — that sandbox only had access to
  package registries. What *was* verified: the fallback preview-image
  renderer against real rendered PNG output (visually inspected, including
  catching and fixing a font-glyph bug), and the Worker's routing/bundling
  against a real local Cloudflare Workers runtime (`wrangler dev`). Do a
  real test after step 3 above (send `/start`, add a real streamer, trigger
  "checker" manually) before trusting it unattended.

## Using the bot

- `/start` — overview
- In a **group**: `/add_channel` (bot must already be admin there)
- For a **channel**: forward any post from it to the bot in DM (bot must
  already be admin there)
- In DM: `/add_social` — pick the channel, then an existing or new
  streamer, then YouTube/TikTok (send the username) or "Add a link" (send a
  label, then a URL — this is where Twitch goes)
- In DM: `/settings` — toggle auto-pin/auto-unpin, edit the alert text
  (`{title}` `{game}` placeholders), see everything attached to each streamer

## Local development (optional — not required for deployment)

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real or throwaway test values
npm run db:migrate:local
npx wrangler dev
npm run typecheck                 # both the Worker and the checker script
npm run check                     # run the checker script once, locally
```
