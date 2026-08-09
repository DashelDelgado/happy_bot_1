import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdminIds, isAdminUser } from "../src/admin.js";

test("parses comma-separated admin IDs", () => {
  assert.deepEqual(parseAdminIds("123,456,789"), new Set([123, 456, 789]));
});

test("supports a single admin ID", () => {
  assert.deepEqual(parseAdminIds("42"), new Set([42]));
});

test("matches admin users from the parsed set", () => {
  const adminIds = parseAdminIds("100,200");
  assert.equal(isAdminUser(200, adminIds), true);
  assert.equal(isAdminUser(300, adminIds), false);
});
