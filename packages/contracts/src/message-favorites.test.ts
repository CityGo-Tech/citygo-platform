import assert from "node:assert/strict";
import test from "node:test";
import {
  messageIdSchema,
  setMessageFavoriteSchema,
  favoriteMessagesQuerySchema,
} from "./message-favorites.js";

test("favorite IDs reject SQL selectors, coercion and bigint overflow without throwing", () => {
  for (const value of [
    "0",
    "01",
    "-1",
    "1/2",
    "1e3",
    "1' or true--",
    "9223372036854775808",
    "a",
    1,
    null,
  ])
    assert.equal(messageIdSchema.safeParse(value).success, false);
  assert.equal(
    messageIdSchema.parse("9223372036854775807"),
    "9223372036854775807",
  );
});
test("favorite commands accept explicit booleans only, not owner/content/toggle", () => {
  assert.deepEqual(setMessageFavoriteSchema.parse({ saved: false }), {
    saved: false,
  });
  for (const value of [
    {},
    { saved: "true" },
    { saved: true, userId: "2" },
    { saved: true, content: "forged" },
  ])
    assert.equal(setMessageFavoriteSchema.safeParse(value).success, false);
  assert.equal(
    favoriteMessagesQuerySchema.safeParse({ userId: "2" }).success,
    false,
  );
});
