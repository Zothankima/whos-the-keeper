import test from "node:test";
import assert from "node:assert/strict";
import { ROOM_CODE_CHARS, cleanNickname, nicknameKey, normalizeText, guessMatches, buildHint } from "../game-rules.js";

test("room-code alphabet has unique, unambiguous characters", () => {
  assert.equal(ROOM_CODE_CHARS.length, new Set(ROOM_CODE_CHARS).size);
  assert.match("AB23", new RegExp(`^[${ROOM_CODE_CHARS}]{4}$`));
  assert.doesNotMatch("IO10", new RegExp(`^[${ROOM_CODE_CHARS}]{4}$`));
});

test("nickname normalization collapses whitespace, trims and ignores case", () => {
  assert.equal(cleanNickname("  Mango   Boss "), "Mango Boss");
  assert.equal(nicknameKey("MANGO BOSS"), "mango boss");
  assert.equal(cleanNickname("A".repeat(40)).length, 18);
});

test("duplicate-question normalization ignores punctuation and spacing", () => {
  assert.equal(normalizeText("Is it, alive?"), normalizeText(" IS IT alive "));
});

test("guess matching accepts exact answers and small typos but rejects unrelated words", () => {
  assert.equal(guessMatches("  EIFFEL   TOWER ", "Eiffel Tower"), true);
  assert.equal(guessMatches("Pizz", "Pizza"), true);
  assert.equal(guessMatches("Biryanii", "Biryani"), true);
  assert.equal(guessMatches("Elephant", "Pizza"), false);
});

test("hint formatting handles a two-word secret using whitespace", () => {
  assert.equal(buildHint("Mount Everest"), "M____ E______: 5 + 7 letters");
});
