import { test } from "node:test";
import assert from "node:assert/strict";
import { isSuperAdminUsername } from "./super-admins.js";

test("the two configured super-admin usernames match, exact case", () => {
  assert.equal(isSuperAdminUsername("WZ_Casper"), true);
  assert.equal(isSuperAdminUsername("Casper7722026"), true);
});

test("matching is case-insensitive, same as Telegram's own usernames", () => {
  assert.equal(isSuperAdminUsername("wz_casper"), true);
  assert.equal(isSuperAdminUsername("WZ_CASPER"), true);
  assert.equal(isSuperAdminUsername("casper7722026"), true);
  assert.equal(isSuperAdminUsername("CASPER7722026"), true);
});

test("a leading '@' is tolerated", () => {
  assert.equal(isSuperAdminUsername("@WZ_Casper"), true);
});

test("an unrelated username does not match", () => {
  assert.equal(isSuperAdminUsername("some_random_user"), false);
});

test("undefined and null (no @username set at all) never match", () => {
  assert.equal(isSuperAdminUsername(undefined), false);
  assert.equal(isSuperAdminUsername(null), false);
});

test("an empty string never matches", () => {
  assert.equal(isSuperAdminUsername(""), false);
});

test("a username that merely contains one of the allowed names as a substring does not match", () => {
  assert.equal(isSuperAdminUsername("WZ_Casper_fake"), false);
  assert.equal(isSuperAdminUsername("not_wz_casper"), false);
});
