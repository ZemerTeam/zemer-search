import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFemaleMatcher, isFemaleInvolved } from "./credits.mjs";

const M = buildFemaleMatcher([
  { isFemale: true, name: "Franciska" },
  { isFemale: false, name: "C Lanzbom" },
  { isFemale: true, name: "מלכי" },        // Hebrew; consonant skeleton "mlk"
  { isFemale: false, name: "Yonatan" },
]);

test("title feat-credit female → involved (the proven DJ MUSIIX leak)", () => {
  assert.equal(isFemaleInvolved("Shiru (Remix) (feat. Franciska)", "DJ MUSIIX", false, M), true);
});
test("male primary feat male → NOT involved (guards over-filtering)", () => {
  assert.equal(isFemaleInvolved("Some Song (feat. C Lanzbom)", "Beri Weber", false, M), false);
});
test("credit marker but no female match → NOT involved ('Take Me with Your Words')", () => {
  assert.equal(isFemaleInvolved("Take Me with Your Words", "Rabbi Shlomo Carlebach", false, M), false);
});
test("female PRIMARY → involved (existing behavior preserved)", () => {
  assert.equal(isFemaleInvolved("Franciska feat. C Lanzbom", "Franciska", true, M), true);
});
test("cross-script: romanized 'Malky' matches Hebrew female whitelist entry מלכי", () => {
  assert.equal(isFemaleInvolved("Niggun (feat. Malky)", "Some Choir", false, M), true);
});
test("cross-script reverse: Hebrew credit matches romanized female entry", () => {
  const M2 = buildFemaleMatcher([{ isFemale: true, name: "Malky" }]);
  assert.equal(isFemaleInvolved("ניגון (feat. מלכי)", "מקהלה", false, M2), true);
});
test("whole-token only: male 'Yonatan' is NOT clipped by a female 'Yona'", () => {
  const M3 = buildFemaleMatcher([{ isFemale: true, name: "Yona" }]);
  assert.equal(isFemaleInvolved("Song (feat. Yonatan)", "Choir", false, M3), false);
});
test("artist-string secondary female credit → involved", () => {
  assert.equal(isFemaleInvolved("Plain Title", "DJ X & Franciska", false, M), true);
});
test("empty matcher → never involved (safe default; unknown names never drop)", () => {
  assert.equal(isFemaleInvolved("Anything (feat. Nobody)", "X", false, buildFemaleMatcher([])), false);
});
