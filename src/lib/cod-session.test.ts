import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCodSession } from "./cod-session.js";
import type { ActivisionSessionRow } from "../types.js";

function row(partial: Partial<ActivisionSessionRow>): ActivisionSessionRow {
  return { id: 1, email: null, password: null, cookie_value: null, updated_at: "2026-01-01", ...partial };
}

test("resolveCodSession returns not_configured when no row exists at all", () => {
  const result = resolveCodSession(null);
  assert.deepEqual(result, { ok: false, reason: "not_configured" });
});

test("resolveCodSession returns cookie_missing when the row exists but cookie_value is null", () => {
  const result = resolveCodSession(row({ cookie_value: null }));
  assert.deepEqual(result, { ok: false, reason: "cookie_missing" });
});

test("resolveCodSession returns cookie_missing for a blank/whitespace-only cookie, not a false success", () => {
  assert.deepEqual(resolveCodSession(row({ cookie_value: "" })), { ok: false, reason: "cookie_missing" });
  assert.deepEqual(resolveCodSession(row({ cookie_value: "   " })), { ok: false, reason: "cookie_missing" });
});

test("resolveCodSession succeeds and carries the cookie as ssoToken when one is set", () => {
  const result = resolveCodSession(row({ cookie_value: "abc123" }));
  assert.deepEqual(result, { ok: true, session: { ssoToken: "abc123" } });
});

test("resolveCodSession trims the stored cookie before using it", () => {
  const result = resolveCodSession(row({ cookie_value: "  abc123  " }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.session.ssoToken, "abc123");
});

test("resolveCodSession never attempts a password login -- email/password presence alone is not enough without a cookie", () => {
  // Это закрепляет решение владельца: "только cookie, без попытки входа
  // по паролю вообще" -- email+пароль заданы, но cookie нет, значит
  // результат всё равно cookie_missing, а НЕ какая-то попытка логина по
  // email/password.
  const result = resolveCodSession(row({ email: "bot@example.com", password: "hunter2", cookie_value: null }));
  assert.deepEqual(result, { ok: false, reason: "cookie_missing" });
});
