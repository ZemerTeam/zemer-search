// Normalization / transliteration — the cross-script fuzzy layer (prototype of the eventual pure-Kotlin
// on-device version: pure string ops, no platform ICU, deterministic).
//
// Two token forms per string:
//   plain    — NFD-strip diacritics/niqqud, lowercase, fold to [a-z0-9], tokens. Matches Latin text and
//              the romanizations already embedded in many titles.
//   skeleton — a Hebrew-aware CONSONANT skeleton. Hebrew titles are written without vowels, so we
//              romanize the *strong* consonants and DROP the matres lectionis (א ה ו י ע) + Latin vowels,
//              then fold ambiguous pairs (b/v=ב, k/ch=כ/ק, p/f=פ, s/sh=ס/שׁ, t/th=ט/ת, tz=צ). This makes a
//              romanized query ("kevakarat", "dudi polak") align with the Hebrew title (כבקרת, דודי פולק).

const COMBINING = /\p{Mn}+/gu;
// In-word marks (ASCII/curly apostrophes, backtick, acute, double-quote, Hebrew geresh ׳ / gershayim ״)
// are REMOVED, not treated as word breaks — so "L'Chaim", "LChaim" and "lchaim", or "ג'רופי" / "גרופי",
// all tokenize identically. Otherwise an apostrophe splits the word and a user who omits it gets nothing.
const JOINMARK = /['’‘`´"׳״]/g;

// Hebrew strong consonants → folded Latin class. Matres lectionis (א ה ו י ע) intentionally absent → dropped.
const HEB = {
  "ב": "b", "ג": "g", "ד": "d", "ז": "z", "ח": "k", "ט": "t",
  "כ": "k", "ך": "k", "ל": "l", "מ": "m", "ם": "m", "נ": "n", "ן": "n",
  "ס": "s", "פ": "p", "ף": "p", "צ": "c", "ץ": "c", "ק": "k", "ר": "r",
  "ש": "s", "ת": "t",
};

function romanizeHebrewToSkeleton(s) {
  let out = "";
  for (const ch of s) out += (ch in HEB ? HEB[ch] : (ch >= "֐" && ch <= "׿" ? "" : ch));
  return out;
}

// Fold a Latin run to the same consonant alphabet as the Hebrew skeleton.
function latinToSkeleton(s) {
  return s
    .replace(/sh|ş/g, "s").replace(/ch|kh|ḥ|x/g, "k").replace(/tz|ts/g, "c").replace(/th/g, "t")
    .replace(/[aeiou]/g, "")          // drop vowels
    .replace(/[wyh']/g, "")           // drop semivowels / silent
    .replace(/v/g, "b").replace(/f/g, "p").replace(/q/g, "k").replace(/[^a-z0-9]/g, "");
}

export function plainTokens(str) {
  return (str || "")
    .normalize("NFD").replace(COMBINING, "")
    .toLowerCase().replace(JOINMARK, "").replace(/[^a-z0-9֐-׿]+/g, " ")
    .split(" ").filter(Boolean);
}

// Word-ALIGNED skeleton key: one slot per plain token, no length filter (a token that skeletonizes to
// nothing keeps its plain form). Used ONLY for the exact/begins-with ranking boosts — it preserves word
// count/order so a multi-word name ("Yoni Shlomo" → "n slm") can't collapse to a one-word query's
// skeleton ("shlomo" → "slm") and steal an exact-match boost. Matching still uses skeletonTokens().
export function skeletonKey(str) {
  return plainTokens(str).map((tok) => latinToSkeleton(romanizeHebrewToSkeleton(tok)) || tok).join(" ");
}

export function skeletonTokens(str) {
  const cleaned = (str || "").normalize("NFD").replace(COMBINING, "").toLowerCase().replace(JOINMARK, "");
  const out = [];
  for (const word of cleaned.split(/[^a-z0-9֐-׿]+/).filter(Boolean)) {
    // a word may mix scripts; build its skeleton by romanizing Hebrew then folding the whole thing.
    const romanized = romanizeHebrewToSkeleton(word);
    const sk = latinToSkeleton(romanized);
    if (sk.length >= 2) out.push(sk);
  }
  return out;
}

// Damerau-Levenshtein (optimal string alignment) with an early cap. ADJACENT TRANSPOSITION costs 1 —
// the single most common real typo (and the synthetic case our benchmark stresses). Used for typo
// tolerance on short Latin/skeleton tokens. O(|a|·|b|) on short tokens; rows early-exit past `max`.
export function damerau(a, b, max = 2) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl <= max ? bl : max + 1;
  if (bl === 0) return al <= max ? al : max + 1;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    let best = max + 1;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
  }
  return d[al][bl];
}
