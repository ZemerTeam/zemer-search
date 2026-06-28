// In-memory search index — the engine for BOTH the server (full corpus in RAM) and the on-device
// fallback (subset). Two inverted indexes (plain Latin tokens + Hebrew-aware consonant skeletons) with
// prefix + Damerau typo tolerance, synonym expansion, and RELEVANCE RANKING:
//   • IDF weighting     — a match on a rare/distinctive token (an unusual artist/title word) counts far
//                         more than a common one ("live", "feat", a year), so noise words don't rank.
//   • field awareness   — title vs artist tokens are tracked; a title match weighs slightly above an
//                         artist match, and we can boost by where the query landed.
//   • exact/phrase boost — when the query IS the artist (you searched an artist) their tracks dominate;
//                         when it IS / prefixes the title, that track floats to the top.
//   • coverage gate     — a result must match enough of the query to qualify (precision).
// Scales sub-linearly: prefix via binary search over a sorted vocab; fuzzy via a boundary-padded bigram
// candidate index (only tokens sharing a 2-gram are distance-checked). Deterministic; pure data ops.
import { plainTokens, skeletonTokens, skeletonKey, damerau } from "./normalize.mjs";
import { expandQuery } from "./synonyms.mjs";

const TITLE = 1, ARTIST = 2;
// A COMPLETED word (not the one being typed) matches exactly + by typo — NOT by prefix. Only the word
// being typed (the last token, with no trailing space) prefix-matches. So "eli " (trailing space ⇒ "eli"
// is finished) matches the word "eli" and NOT "Eliyahu"; "eli" (still typing) prefix-matches "Eliyahu".
const PLAIN = { exact: 10, prefix: 0, fuzzy: 5 };
// Skeleton matches cross-script EXACTLY (a romanized query's consonant skeleton == the Hebrew title's),
// and vowel-typos are already absorbed by dropping vowels — so NO skeleton fuzzy: fuzzy-on-skeleton is
// double-lossy and matches garbage to real words. Precision-first.
const SKEL = { exact: 8, prefix: 0, fuzzy: 0 };
// The LAST query token is the word being typed — a prefix of it IS the intent, so weight it near-exact
// (and enable skeleton prefix, off for completed words, so cross-script as-you-type works).
const PLAIN_LAST = { exact: 10, prefix: 9, fuzzy: 5 };
const SKEL_LAST = { exact: 8, prefix: 7, fuzzy: 0 };
const ARTIST_AFFINITY = 25;     // bonus per query word that matches the ARTIST name — being BY the
                                // searched artist beats merely being mentioned in another track's title
// Precision-first: drop any result scoring below this fraction of the top hit — better to return fewer
// (or nothing) than to pad the list with weak, likely-wrong matches.
const REL_FLOOR = Number(process.env.REL_FLOOR || 0.4);
const uniq = (a) => [...new Set(a)];

// Boundary-padded bigrams: "abc" -> ^a, ab, bc, c$ (so abc↔axc still share ^a and c$).
function bigrams(s) {
  if (!s) return [];
  if (s.length === 1) return ["^" + s, s + "$"];
  const g = ["^" + s[0]];
  for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
  g.push(s[s.length - 1] + "$");
  return g;
}

const newField = () => ({ inv: new Map(), bg: new Map(), sorted: [], idf: new Map() });
function put(field, tok, doc, bit) {
  let m = field.inv.get(tok);
  if (!m) { m = new Map(); field.inv.set(tok, m); }
  m.set(doc, (m.get(doc) || 0) | bit);
}
function finalize(field, N) {
  for (const [tok, postings] of field.inv) {
    field.idf.set(tok, Math.log(1 + N / postings.size)); // rare token → high idf
    for (const g of bigrams(tok)) { let s = field.bg.get(g); if (!s) { s = new Set(); field.bg.set(g, s); } s.add(tok); }
  }
  field.sorted = [...field.inv.keys()].sort();
}

export function buildIndex(tracks, synonyms = []) {
  const N = tracks.length || 1;
  const plain = newField(), skel = newField();
  const titleP = [], titleS = [], artistP = [], artistS = [];
  tracks.forEach((t, i) => {
    const tp = uniq(plainTokens(t.title)), ap = uniq(plainTokens(t.artistName || ""));
    const ts = uniq(skeletonTokens(t.title)), as = uniq(skeletonTokens(t.artistName || ""));
    for (const tok of tp) put(plain, tok, i, TITLE);
    for (const tok of ap) put(plain, tok, i, ARTIST);
    for (const tok of ts) put(skel, tok, i, TITLE);
    for (const tok of as) put(skel, tok, i, ARTIST);
    titleP.push(tp.join(" ")); artistP.push(ap.join(" "));
    titleS.push(skeletonKey(t.title)); artistS.push(skeletonKey(t.artistName || ""));
  });
  finalize(plain, N); finalize(skel, N);
  return { tracks, plain, skel, synonyms, keys: { titleP, artistP, titleS, artistS } };
}

function prefixMatches(sorted, qt) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < qt) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < sorted.length && sorted[i].startsWith(qt); i++) if (sorted[i] !== qt) out.push(sorted[i]);
  return out;
}
function bigramCandidates(field, qt) {
  const cand = new Set();
  for (const g of bigrams(qt)) { const s = field.bg.get(g); if (s) for (const t of s) cand.add(t); }
  cand.delete(qt);
  return cand;
}

// One query token → Map<doc, {w, mask}>. w = base(matchType) × idf(matchedToken); mask = where it hit.
function matchToken(field, qt, cap, weights, minPrefix = 3) {
  const out = new Map();
  // `strong` = exact/prefix (a confident field hit). A FUZZY match still adds to the score but contributes
  // mask 0 — so a fuzzy hit ("yom"→"you") can't grant artist-affinity or a field-position boost it didn't
  // really earn.
  const consider = (v, base, strong) => {
    const idf = field.idf.get(v) || 1;
    const postings = field.inv.get(v);
    if (!postings) return;
    const w = base * idf;
    for (const [doc, mask] of postings) {
      const eff = strong ? mask : 0;
      const cur = out.get(doc);
      if (!cur) out.set(doc, { w, mask: eff });
      else { cur.mask |= eff; if (w > cur.w) cur.w = w; }
    }
  };
  if (field.inv.has(qt)) consider(qt, weights.exact, true);
  if (weights.prefix && qt.length >= minPrefix) for (const v of prefixMatches(field.sorted, qt)) consider(v, weights.prefix, true);
  // Fuzzy only when this field uses it (plain only) and both tokens ≥3 — a 1-edit match on a 2-char
  // token is ~50% different and surfaces garbage.
  if (weights.fuzzy && qt.length >= 3) for (const v of bigramCandidates(field, qt)) {
    if (v.length >= 3 && Math.abs(v.length - qt.length) <= cap && damerau(v, qt, cap) <= cap) consider(v, weights.fuzzy, false);
  }
  return out;
}

const popcount = (x) => { x -= (x >> 1) & 0x55555555; x = (x & 0x33333333) + ((x >> 2) & 0x33333333); return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24; };
const startsWith = (key, prefix) => !!prefix && key.startsWith(prefix);

export function search(index, query, k = 10) {
  const qp0 = uniq(plainTokens(query)), qs0 = uniq(skeletonTokens(query));
  if (!qp0.length && !qs0.length) return [];
  const { plain: qp, skel: qs } = expandQuery(qp0, qs0, index.synonyms || []);
  const qpKey = qp0.join(" ");
  // Word-aligned skeleton key for the exact/begins boosts, used only when ≥3 chars (a 2-char skeleton
  // like "chaim"→"km" is too ambiguous for an exact-match boost).
  const skKeyRaw = skeletonKey(query);
  const skKey = skKeyRaw.length >= 3 ? skKeyRaw : "";
  const origCount = Math.max(qp0.length, qs0.length);
  const need = Math.max(1, Math.ceil(origCount / 2));

  // Per doc: relevance score + coverage bitmasks (one bit per query token; popcount = #matched) for the
  // whole query and for the ARTIST field. Integer ops, no per-doc Set allocation → fast.
  const acc = new Map();
  const get = (doc) => { let a = acc.get(doc); if (!a) { a = { score: 0, mP: 0, mS: 0, aP: 0, aS: 0 }; acc.set(doc, a); } return a; };
  // A trailing space means the last word is FINISHED → no word is "being typed" → no prefix anywhere
  // (so "eli " matches the word "eli", not "Eliyahu"). No trailing space → the last token is the prefix.
  const typing = !/\s$/.test(query);
  const lastP = typing ? qp0.length - 1 : -1, lastS = typing ? qs0.length - 1 : -1;
  qp.forEach((qt, i) => { const bit = i < 31 ? (1 << i) : 0; const last = i === lastP; for (const [doc, m] of matchToken(index.plain, qt, 1, last ? PLAIN_LAST : PLAIN, last ? 2 : 3)) { const a = get(doc); a.score += m.w; a.mP |= bit; if (m.mask & ARTIST) a.aP |= bit; } });
  // A 2-char consonant skeleton (e.g. "avr"→"br") is far too ambiguous — it exact-matches "Beri"/"Bar"
  // and prefix-matches "Barditchover"/"Bronx". So skip skeleton matching below 3 chars; short queries
  // rely on the precise plain prefix. (Cross-script needs ≥3-char skeletons like "kbk" to be specific.)
  qs.forEach((qt, i) => { if (qt.length < 3) return; const bit = i < 31 ? (1 << i) : 0; const last = i === lastS; for (const [doc, m] of matchToken(index.skel, qt, qt.length <= 4 ? 1 : 2, last ? SKEL_LAST : SKEL, 2)) { const a = get(doc); a.score += m.w; a.mS |= bit; if (m.mask & ARTIST) a.aS |= bit; } });

  const K = index.keys;
  const out = [];
  for (const [doc, a] of acc) {
    const cov = Math.max(popcount(a.mP), popcount(a.mS));
    if (cov < need) continue;
    const artistCov = Math.max(popcount(a.aP), popcount(a.aS));
    // Precise boosts from the stored field keys (string compares, cheap): searched-the-artist / is-the-title win.
    let boost = 1 + (cov >= origCount ? 0.4 : 0);                                            // matched the whole query
    // Rank by MATCH POSITION: exact > begins-with > contains. begins-with is checked BEFORE the contains
    // tier so a name/title that merely CONTAINS the query never ties one that BEGINS WITH it.
    if (K.artistP[doc] === qpKey || (skKey && K.artistS[doc] === skKey)) boost += 2.5;       // exact artist
    else if (startsWith(K.artistP[doc], qpKey) || startsWith(K.artistS[doc], skKey)) boost += 1.6; // artist BEGINS WITH
    else if (artistCov >= origCount) boost += 0.8;                                           // artist CONTAINS query
    if (K.titleP[doc] === qpKey || (skKey && K.titleS[doc] === skKey)) boost += 2.0;         // exact title
    else if (startsWith(K.titleP[doc], qpKey) || startsWith(K.titleS[doc], skKey)) boost += 1.4; // title BEGINS WITH
    // cov×8: matching MORE query words wins even when common. artistCov×AFFINITY (prefer the real artist)
    // applies only to MULTI-word queries — for a single common word ("tov") it would let a coincidental
    // mid-artist-name match outrank a title that BEGINS with the word; there the position boosts decide.
    const score = (a.score + cov * 8 + (origCount >= 2 ? artistCov * ARTIST_AFFINITY : 0)) * boost;
    out.push({ doc, track: index.tracks[doc], score, coverage: cov });
  }
  out.sort((a, b) => b.score - a.score || a.track.title.length - b.track.title.length ||
    String(a.track.videoId ?? a.track.id ?? "").localeCompare(String(b.track.videoId ?? b.track.id ?? "")));
  // Precision floor: keep only results within REL_FLOOR of the best — fewer/none over weak & wrong.
  if (!out.length) return out;
  const floor = out[0].score * REL_FLOOR;
  const kept = [];
  for (const r of out) { if (r.score < floor || kept.length >= k) break; kept.push(r); }
  return kept;
}
