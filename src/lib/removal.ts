// Tears down a monitored platform account or an entire streamer, including
// the external cleanup neither a bare D1 DELETE nor src/db.ts alone can do:
// unsubscribing a Kick account from Kick's webhook before its local row
// (and OAuth token) disappear. Used by src/handlers/telegram.ts's streamer
// management screens (see /settings in the bot).
import {
  deleteSocialAccount,
  deleteStreamer,
  getKickTokenBySocialAccount,
  listSocialAccountsByStreamer,
} from "../db.js";
import { refreshAccessToken, unsubscribeFromEvents } from "./kick.js";
import type { Env, SocialAccountRow } from "../types.js";

/** Best-effort: unsubscribes a Kick social account from Kick's webhook,
 * refreshing its access token first if it's expired (see kick.ts's own
 * "NOTE on token refresh" -- this is the call that comment was written for).
 * No-op for any other platform. Never throws -- this always runs right
 * before deleting the account's local row regardless of whether the remote
 * unsubscribe succeeds, since a failure here (Kick's API unreachable, or
 * the streamer having already revoked the app from their own Kick
 * settings) shouldn't block removing the account from the bot. Kick
 * auto-expires an unreachable subscription after 24h on its own anyway
 * (see kick.ts's operational note), so a failed unsubscribe here is a
 * missed optimization, not a leak. */
async function unsubscribeKickIfNeeded(env: Env, account: SocialAccountRow): Promise<void> {
  if (account.platform !== "kick") return;

  const token = await getKickTokenBySocialAccount(env, account.id);
  if (!token || !token.event_subscription_id) return;
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
    console.error(
      `Cannot unsubscribe Kick account ${account.id} from its webhook: KICK_CLIENT_ID/KICK_CLIENT_SECRET is not configured`,
    );
    return;
  }

  let accessToken = token.access_token;
  if (new Date(token.expires_at).getTime() <= Date.now()) {
    try {
      const refreshed = await refreshAccessToken({
        clientId: env.KICK_CLIENT_ID,
        clientSecret: env.KICK_CLIENT_SECRET,
        refreshToken: token.refresh_token,
      });
      accessToken = refreshed.access_token;
    } catch (err) {
      console.error(`Failed to refresh Kick token before unsubscribing account ${account.id}`, err);
      return;
    }
  }

  try {
    await unsubscribeFromEvents(accessToken, token.event_subscription_id);
  } catch (err) {
    console.error(`Failed to unsubscribe Kick account ${account.id} from its webhook`, err);
  }
}

/** Unlinks one monitored platform account from its streamer. The only
 * place in this codebase that should remove a social_accounts row -- see
 * deleteSocialAccount's own doc comment in src/db.ts for why calling that
 * directly instead would skip the Kick cleanup above. */
export async function removeSocialAccount(env: Env, account: SocialAccountRow): Promise<void> {
  await unsubscribeKickIfNeeded(env, account);
  await deleteSocialAccount(env, account.id);
}

/** Deletes a streamer and everything under it (schema.sql's ON DELETE
 * CASCADE handles social_accounts, extra_links, kick_tokens, posts,
 * post_platforms). The only place in this codebase that should remove a
 * streamers row -- see deleteStreamer's own doc comment in src/db.ts.
 * Unsubscribes every Kick account the streamer owns from its webhook
 * first, same as removeSocialAccount does for a single one. */
export async function removeStreamer(env: Env, streamerId: number): Promise<void> {
  const accounts = await listSocialAccountsByStreamer(env, streamerId);
  for (const account of accounts) {
    await unsubscribeKickIfNeeded(env, account);
  }
  await deleteStreamer(env, streamerId);
}
