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
- **GitHub Actions** — both the recurring YouTube/TikTok checker *and* all
  deployment (schema migration, secrets, `wrangler deploy`) run here, not on
  your machine and not from wherever this was built. See "Deploy" below —
  this is the direct answer to "why files and not a running bot": deploying
  requires authenticating as *you* on Cloudflare/Telegram/Twitch/GitHub,
  which isn't something to hand to an assistant mid-chat. Once those
  credentials are repo secrets, GitHub Actions does the rest on every push.

`src/lib/publish.ts` and `scripts/lib/publish.ts` implement the same
"post or merge" rule in both places: if a streamer's platform goes live (or
publishes a new video) while another platform for the *same* streamer
already has an open post, the new platform's button is added to that post
instead of sending a second message. A platform's button is removed when it
ends; the post is unpinned and closed once every platform under it has ended.

## Deploy (GitHub Actions does the actual deploying)

### 0. One-time accounts/credentials

- Telegram bot token: message [@BotFather](https://t.me/BotFather) → `/newbot`
- Cloudflare account (Workers + D1 are free tier) — note your **Account ID**
  (dashboard right sidebar) and your **workers.dev subdomain** (Workers &
  Pages → Overview; set one if you haven't)
- Cloudflare API token: dashboard → My Profile → API Tokens → Create
  Token → permissions **Account.D1: Edit** and **Account.Workers Scripts: Edit**
- Twitch app: [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
  → Register → any name, redirect URL `https://localhost`, category
  "Application Integration" → copy Client ID, generate Client Secret
- (Optional) YouTube Data API v3 key: [console.cloud.google.com](https://console.cloud.google.com)
  → enable the API → Credentials → API key — without this, YouTube live
  detection falls back to a best-effort page check (see Limitations)

None of these can be created by an assistant on your behalf — each one is
tied to proving it's *you* on that platform.

### 1. Get the code into a repo you control

Either push it yourself:

```bash
cd neurocasper
git init && git add -A && git commit -m "Initial import"
gh repo create neurocasper --private --source=. --push   # needs GitHub CLI + login
# no gh CLI? create an empty repo on github.com, then:
#   git remote add origin https://github.com/<you>/neurocasper.git
#   git push -u origin main
```

or, if you'd rather I push it: create an empty repo, generate a
**fine-grained personal access token** scoped to just that one repo with
**Contents: Read and write**, and share it here — I'll push and then you
can revoke it. (I have no way to create the repo myself — that also
requires authenticating as you on GitHub.)

### 2. Add repo secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | from step 0 |
| `CLOUDFLARE_API_TOKEN` | from step 0 |
| `BOT_TOKEN` | from BotFather |
| `WEBHOOK_SECRET` | make up a long random string |
| `TWITCH_CLIENT_ID` | from step 0 |
| `TWITCH_CLIENT_SECRET` | from step 0 |
| `TWITCH_EVENTSUB_SECRET` | make up a second long random string |
| `YOUTUBE_API_KEY` | optional, from step 0 |
| `CLOUDFLARE_D1_DATABASE_ID` | comes from step 3 below — add it after |

### 3. Run the workflows, in order, from the repo's **Actions** tab

1. **"1) Bootstrap D1 database"** — Run workflow (button, top right). Open
   the run, copy the `database_id` it prints.
2. Edit `wrangler.toml` in the GitHub web UI: paste that id over
   `REPLACE_WITH_D1_DATABASE_ID`, and set `WORKER_URL` to
   `https://neurocasper.<your-workers.dev-subdomain>.workers.dev` (replacing
   `REPLACE_WITH_YOUR_WORKER_URL`). Commit directly to `main`.
3. Add the `CLOUDFLARE_D1_DATABASE_ID` repo secret (same id as step 1).
4. That commit auto-triggers **"2) Deploy Worker"** — applies the schema,
   syncs secrets, deploys. Watch it go green.
5. Run **"3) Set Telegram webhook"** once, manually — points Telegram at
   the now-deployed Worker.

From here on, every push to `main` that touches the Worker redeploys
automatically, and **"4) NeuroCasper YouTube/TikTok checker"** runs on its
own every 5 minutes — no local commands needed for normal operation.

## Known limitations (read before relying on this)

- **Telegram inline buttons have no color setting** — the Bot API doesn't
  expose one, so "red/purple/black buttons" isn't literally achievable.
  What's shipped: a colored emoji circle in the button label (🔴 YouTube /
  🟣 Twitch / ⚫ TikTok). Full color control *is* available for the
  generated fallback preview image, since that's pixels the bot draws
  itself — see `src/lib/preview-image.ts`.
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
- **Deploy/secrets CI (`2) Deploy Worker`) uses Cloudflare's own
  `cloudflare/wrangler-action`**, not raw `wrangler secret put` piped by hand
  — that raw pattern has a real, documented bug where it doesn't trim the
  trailing newline `echo` adds (cloudflare/workers-sdk#993), which would
  have silently corrupted every secret. The action's `secrets:` input
  avoids that. This still wasn't runnable end-to-end from the sandbox this
  was built in (no Cloudflare API access there), so its first real run with
  real credentials is still the first full proof — if it fails, the error
  will name which step; most likely fix is a mis-scoped `CLOUDFLARE_API_TOKEN`.
- **Not network-tested against the real Telegram/Twitch/YouTube/TikTok
  APIs** for the same reason. What *was* verified: the Worker's own logic
  (routing, Twitch webhook HMAC verification, the challenge/response flow,
  background-processing pattern) against a real local Cloudflare Workers
  runtime (`wrangler dev`), and the fallback preview-image renderer against
  real rendered PNG output (visually inspected, including catching and
  fixing a font-glyph bug). Do a real test after step 3 above (send
  `/start`, add a real streamer, trigger "4)" manually) before trusting it
  unattended.

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
