// "Featuring" female detection — closes the gap where a male-primary track FEATURES a female artist
// (the credit is in the TITLE, e.g. "Shiru (Remix) (feat. Franciska)", or a secondary artist credit).
// The primary-artist `isFemale` flag is checked elsewhere; this widens the set of names considered to
// EVERY credited artist, then validates each candidate against the female whitelist so unknown names can
// never over-filter (only positively-known female artists trigger a drop).
//
// Reuses the index normalizer (cross-script skeleton + whole-token plain form) — the SAME matcher the rest
// of search uses — so a feature credited in Hebrew matches a romanized whitelist entry and vice-versa, and
// matching is whole-token equality (never a loose substring, so male "Yonatan" isn't clipped by "Yona").
import { plainTokens, skeletonKey } from "./normalize.mjs";

const norm = (s) => plainTokens(s).join(" ");                 // whole normalized name (Latin + romanizations)
const skel = (s) => skeletonKey(s).replace(/\s+/g, "");       // consonant skeleton, no spaces
const hasHeb = (s) => /[֐-׿]/.test(s || "");                  // contains a Hebrew letter

// Build a matcher from the whitelist's female artists: exact normalized full names, plus consonant
// skeletons tagged with the SCRIPT of the entry. The skeleton is for CROSS-SCRIPT alignment only (a Hebrew
// whitelist name vs a romanized credit, or vice-versa) — same-script skeleton matching collides badly
// ("Asher Weiss"→"srss"="Sarah Shasho", "Munch"→"mnk"="Menucha"), so same-script must hit the exact name.
// Skeletons gate at ≥3 chars (a 2-char skeleton collides — gotcha #1).
export function buildFemaleMatcher(artists = []) {
  const names = new Set(), skels = new Map(); // skeleton -> {heb, lat}: which scripts a female with it uses
  for (const a of artists) {
    if (!a?.isFemale || !a.name) continue;
    const n = norm(a.name); if (n) names.add(n);
    const sk = skel(a.name);
    if (sk.length >= 3) { const e = skels.get(sk) || { heb: false, lat: false }; if (hasHeb(a.name)) e.heb = true; else e.lat = true; skels.set(sk, e); }
  }
  return { names, skels };
}

const matchesFemale = (name, m) => {
  const n = norm(name); if (n && m.names.has(n)) return true;     // exact normalized name (handles same-script)
  const sk = skel(name); if (sk.length < 3) return false;
  const e = m.skels.get(sk); if (!e) return false;
  return hasHeb(name) ? e.lat : e.heb;                            // skeleton matches ONLY across scripts
};

// Split a credit string into individual artist names on the usual credit separators (incl. Hebrew עם).
const SPLIT = /\s*(?:,|&|\+|·|\/|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\band\b|\bvs\.?\b|×|עם)\s*/i;
const splitNames = (s) => s.split(SPLIT).map((x) => x.trim()).filter(Boolean);

// TITLE credits — ONLY text introduced by an explicit credit marker (never scan the whole title). Inside a
// parenthetical, "with"/"duet" also count (clearly a credit there); a non-parenthetical tail requires a
// STRONG marker (feat/ft/featuring) so a plain "…with Your Words" title yields no candidate at all.
const CREDIT_PAREN = /(?:feat\.?|ft\.?|featuring|duet(?:\s+with)?|with)\s+(.+)/i;
const CREDIT_TAIL = /(?:feat\.?|ft\.?|featuring)\s+(.+)/i;
function titleCredits(title = "") {
  const out = [];
  for (const m of title.matchAll(/[([{]([^)\]}]*)[)\]}]/g)) {
    const c = m[1].match(CREDIT_PAREN); if (c) out.push(...splitNames(c[1]));
  }
  const tail = title.replace(/[([{][^)\]}]*[)\]}]/g, " ").match(CREDIT_TAIL);
  if (tail) out.push(...splitNames(tail[1]));
  return out;
}
// ARTIST-string credits — split the whole credit string; the primary is already covered by its isFemale
// flag, so this catches a female credited as a SECONDARY artist in the artist field.
const artistCredits = (artistName = "") => splitNames(artistName);

// Is ANY credited artist (primary flag, or a title / artist-string credit matching a known female) female?
export function isFemaleInvolved(title, artistName, primaryIsFemale, m) {
  if (primaryIsFemale) return true;
  if (!m || (!m.names.size && !m.skels.size)) return false;
  for (const c of titleCredits(title || "")) if (matchesFemale(c, m)) return true;
  for (const c of artistCredits(artistName || "")) if (matchesFemale(c, m)) return true;
  return false;
}

// Convenience: the set of videoIds that are female-involved (for the server's SQL paths / temp _female).
// Mutates each track's `femaleInvolved` so the in-memory category docs reuse the same computation.
export function collectFemaleVideoIds(tracks, m) {
  const ids = new Set();
  for (const t of tracks) {
    t.femaleInvolved = isFemaleInvolved(t.title, t.artistName, t.isFemale, m);
    if (t.femaleInvolved) ids.add(t.videoId);
  }
  return ids;
}

export { titleCredits as _titleCredits }; // exported for tests
