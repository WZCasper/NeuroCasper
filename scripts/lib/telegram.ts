// Minimal raw Telegram Bot API client for the checker script. No grammY here
// on purpose — this is a small, single-purpose Node script (not a bot that
// processes updates), so a handful of fetch calls is simpler than pulling in
// and configuring a full bot framework for a one-shot cron job.
export interface InlineButton {
  text: string;
  url: string;
}

export interface SendResult {
  message_id: number;
}

function endpoint(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function parseTelegramResponse<T>(res: Response, method: string): Promise<T> {
  let json: { ok: boolean; result: T; description?: string };
  try {
    json = (await res.json()) as { ok: boolean; result: T; description?: string };
  } catch {
    throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${res.statusText} (non-JSON response)`);
  }
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.statusText}`);
  }
  return json.result;
}

async function postJson<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(endpoint(botToken, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseTelegramResponse<T>(res, method);
}

/** Sends a photo referenced by URL (used when the platform gives us a real
 * thumbnail URL — Telegram fetches it directly, no upload needed). */
export async function sendPhotoUrl(
  botToken: string,
  chatId: number,
  photoUrl: string,
  caption: string,
  buttons: InlineButton[][],
): Promise<SendResult> {
  return postJson<SendResult>(botToken, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    reply_markup: { inline_keyboard: buttons },
  });
}

/** Uploads raw photo bytes (used for the generated fallback preview card,
 * which only exists in memory, not at a URL). */
export async function sendPhotoBytes(
  botToken: string,
  chatId: number,
  photoBytes: Uint8Array,
  filename: string,
  caption: string,
  buttons: InlineButton[][],
): Promise<SendResult> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
  form.append("photo", new Blob([new Uint8Array(photoBytes)], { type: "image/png" }), filename);

  const res = await fetch(endpoint(botToken, "sendPhoto"), { method: "POST", body: form });
  return parseTelegramResponse<SendResult>(res, "sendPhoto (bytes)");
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  buttons: InlineButton[][],
): Promise<SendResult> {
  return postJson<SendResult>(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function editMessageReplyMarkup(
  botToken: string,
  chatId: number,
  messageId: number,
  buttons: InlineButton[][],
): Promise<void> {
  await postJson(botToken, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function pinChatMessage(botToken: string, chatId: number, messageId: number): Promise<void> {
  await postJson(botToken, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

export async function unpinChatMessage(botToken: string, chatId: number, messageId: number): Promise<void> {
  await postJson(botToken, "unpinChatMessage", { chat_id: chatId, message_id: messageId });
}
