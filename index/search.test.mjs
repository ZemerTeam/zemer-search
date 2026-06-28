import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search } from "./search.mjs";
import { compileSynonyms } from "./synonyms.mjs";

const corpus = [
  { videoId: "aaaaaaaaaaa", title: "כבקרת", artistName: "דודי פולק" },
  { videoId: "bbbbbbbbbbb", title: "שער אשר נסגר", artistName: "נתנאל זלבסקי" },
  { videoId: "ccccccccccc", title: "Heaven on Earth", artistName: "Chana B" },
  { videoId: "ddddddddddd", title: "מקודשת", artistName: "בנימין אצרף" },
];
const idx = buildIndex(corpus);
const ids = (q) => search(idx, q, 5).map((r) => r.track.videoId);

test("romanized Latin query finds the Hebrew-titled track (cross-script)", () => {
  assert.ok(ids("kevakarat").includes("aaaaaaaaaaa"));
  assert.ok(ids("dudi polak").includes("aaaaaaaaaaa"));
  assert.ok(ids("natanel zelevski").includes("bbbbbbbbbbb"));
  assert.ok(ids("binyamin").includes("ddddddddddd"));
});

test("typo'd Latin query still matches (Damerau transposition)", () => {
  assert.ok(ids("heavne on earth").includes("ccccccccccc"));
});

test("a native Hebrew query matches its track", () => {
  assert.ok(ids("כבקרת").includes("aaaaaaaaaaa"));
});

test("unrelated query returns nothing (no false positives)", () => {
  assert.equal(search(idx, "qwerty zxcvbn").length, 0);
});

test("precision: no skeleton fuzzy — a non-word near a real skeleton does not match", () => {
  // "Baruch" skeleton = brk; "boron" skeleton = brn (1 edit). With skeleton fuzzy OFF it must NOT match,
  // and the plain forms are far apart — so the right answer is zero results, not a wrong one.
  const idx2 = buildIndex([{ videoId: "brh00000001", title: "Baruch", artistName: "A Singer" }]);
  assert.equal(search(idx2, "boron").length, 0);
});

test("results are deterministic and ranked (top result is the intended track)", () => {
  assert.equal(search(idx, "dudi polak kevakarat", 1)[0].track.videoId, "aaaaaaaaaaa");
});

test("synonym groups expand a query to an equivalent form", () => {
  assert.equal(search(idx, "mbd").length, 0); // no synonyms loaded → no match
  const synIdx = buildIndex(corpus, compileSynonyms([["mbd", "binyamin"]]));
  assert.ok(search(synIdx, "mbd", 5).some((r) => r.track.videoId === "ddddddddddd"));
});

test("a track BY the searched artist outranks one that only mentions them in its title", () => {
  const idx2 = buildIndex([
    { videoId: "own00000001", title: "Hashem Adoneinu", artistName: "Moshe Mendlowitz" },
    { videoId: "ment0000001", title: "Hashem Shimah feat Moshe Mendlowitz", artistName: "Shmuel Brazil" },
  ]);
  assert.equal(search(idx2, "moshe mendlowitz", 5)[0].track.videoId, "own00000001");
});

test("a completed word (trailing space) matches exactly, not by prefix — 'eli ' is not 'Eliyahu'", () => {
  const idx = buildIndex([
    { videoId: "eli00000001", title: "Eli", artistName: "A" },
    { videoId: "eliyahu0001", title: "Eliyahu", artistName: "B" },
  ]);
  assert.equal(search(idx, "eli", 5).length, 2);          // still typing → prefix → both
  const done = search(idx, "eli ", 5);                     // trailing space → completed → exact only
  assert.equal(done.length, 1);
  assert.equal(done[0].track.videoId, "eli00000001");
});

test("a fuzzy artist match grants no affinity — a real begins-with still wins", () => {
  const idx = buildIndex([
    { videoId: "begins00001", title: "Yom Zeh", artistName: "Mendy Weiss" },            // BEGINS with yom
    { videoId: "fuzzyaff001", title: "Shabbos Yom Menucha", artistName: "Thank You Hashem" }, // "yom"≈"you" fuzzy in artist
  ]);
  assert.equal(search(idx, "yom", 5)[0].track.videoId, "begins00001");
});

test("in-word apostrophes join — 'lchaim' and \"l'chaim\" both find L'Chaim", () => {
  const idx = buildIndex([{ videoId: "lchaim00001", title: "L'Chaim Tish", artistName: "A" }]);
  assert.equal(search(idx, "lchaim", 5)[0]?.track.videoId, "lchaim00001");
  assert.equal(search(idx, "l'chaim", 5)[0]?.track.videoId, "lchaim00001");
});

test("begins-with ranks above contains (and a token-dropping skeleton can't fake an exact match)", () => {
  const idx = buildIndex([
    { videoId: "begins00001", title: "Shlomo Carlebach", artistName: "A" }, // BEGINS with "shlomo"
    { videoId: "contain0001", title: "Yoni Shlomo", artistName: "B" },       // only CONTAINS it ("Yoni"→"" skel)
  ]);
  assert.equal(search(idx, "shlomo", 5)[0].track.videoId, "begins00001");
});

test("IDF: a distinctive title word outranks a pile of common ones", () => {
  const idx3 = buildIndex([
    { videoId: "rare0000001", title: "Kevakarat", artistName: "X" },
    ...Array.from({ length: 20 }, (_, i) => ({ videoId: "live000000" + i, title: "Live Performance", artistName: "Y" + i })),
  ]);
  assert.equal(search(idx3, "kevakarat live", 5)[0].track.videoId, "rare0000001");
});
