import { test } from "node:test";
import assert from "node:assert/strict";
import { isJoinOrLeaveServiceMessage } from "./service-messages.js";

test("an ordinary text message (neither field present) is not a service message", () => {
  assert.equal(isJoinOrLeaveServiceMessage({}), false);
});

test("new_chat_members with at least one user IS a join service message", () => {
  assert.equal(
    isJoinOrLeaveServiceMessage({ new_chat_members: [{ id: 1, is_bot: false, first_name: "Vasya" }] }),
    true,
  );
});

test("an empty new_chat_members array is NOT treated as a join -- Telegram never actually sends one empty, but a naive Array.isArray-only check would wrongly match it", () => {
  assert.equal(isJoinOrLeaveServiceMessage({ new_chat_members: [] }), false);
});

test("left_chat_member set IS a leave service message", () => {
  assert.equal(isJoinOrLeaveServiceMessage({ left_chat_member: { id: 1, is_bot: false, first_name: "Vasya" } }), true);
});

test("both fields undefined explicitly (as grammY would hand them for an unrelated message) is not a service message", () => {
  assert.equal(isJoinOrLeaveServiceMessage({ new_chat_members: undefined, left_chat_member: undefined }), false);
});
