// Cloudflare D1 REST API client. This script runs under GitHub Actions,
// outside the Worker, so it can't use the D1 binding — it talks to the same
// database over Cloudflare's HTTP API instead.
// Docs: POST /accounts/{account_id}/d1/database/{database_id}/query
export interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

interface D1ApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
}

export function loadD1ConfigFromEnv(): D1Config {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN environment variables.",
    );
  }
  return { accountId, databaseId, apiToken };
}

export async function d1Query<T = Record<string, unknown>>(
  config: D1Config,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  let json: D1ApiResponse<T>;
  try {
    json = (await res.json()) as D1ApiResponse<T>;
  } catch {
    throw new Error(`D1 query failed: HTTP ${res.status} ${res.statusText} (non-JSON response)\nSQL: ${sql}`);
  }

  if (!res.ok || !json.success) {
    const message = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
    throw new Error(`D1 query failed: ${message}\nSQL: ${sql}`);
  }

  return json.result[0]?.results ?? [];
}

export async function d1QueryOne<T = Record<string, unknown>>(
  config: D1Config,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await d1Query<T>(config, sql, params);
  return rows[0] ?? null;
}

export async function d1Run(config: D1Config, sql: string, params: unknown[] = []): Promise<void> {
  await d1Query(config, sql, params);
}
