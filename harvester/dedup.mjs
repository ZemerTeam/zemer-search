// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Near-duplicate guard for the generated playlists: the SAME song re-uploaded under a different videoId
// (same artist, effectively-identical title) must not occupy two chart slots. Deliberately CONSERVATIVE —
// precision-first, like the matcher:
//   • Cross-ARTIST same-title never collapses (gotcha #9: many songs legitimately share a title).
//   • VARIANT MARKERS distinguish, never merge: "Home Again" vs "Home Again (Acapella)" are different
//     recordings people deliberately choose between (critical during the Three Weeks) — each marker
//     class (acapella/vocal, instrumental, live, remix, cover) is part of the key.
//   • Otherwise the normalized title must match essentially verbatim (case/punctuation-insensitive) —
//     titles that differ by a real word are trusted to be different content.

// One class per VARIANT dimension: a marker's presence changes the key, so a marked title can never
// collapse into an unmarked one. (Broader than the auto-add's CLEAR_ACAP on purpose: that one must be
// STRICT — it admits songs into the acapella set; this one only needs to distinguish — over-matching
// here is safe, it just prevents a merge.)
const VARIANT_MARKS = [
  /a[\s-]?c+app?ell?a|\bvocal\b|ווקאל|וואקאל|אקפלה/i, // acapella / vocal-version family
  /\binstrumental\b/i,
  /\blive\b|בהופעה/i,
  /\bremix\b/i,
  /\bcover\b|קאבר/i,
];

// Key: artist + caller-supplied trait signature + variant-marker signature + normalized title.
// `traits` carries what the TITLE can't say — isVideo (a song and its cross-listed music VIDEO are
// different recordings with separately-earned reach) and acapella-set membership (an UNLABELED acapella
// version has an identical title; only curation knows it's different). Same key ⇒ duplicate.
// Title base: in-word apostrophes/geresh JOIN (gotcha #6 — "L'Chaim" == "LChaim"), everything else
// punctuation/case-insensitive.
export function dupKey(title, artistId, traits = "") {
  const t = String(title || "");
  const marks = VARIANT_MARKS.map((re, i) => (re.test(t) ? i : "")).join("");
  const base = t.toLowerCase().normalize("NFKC").replace(/['’‘`׳"״]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${artistId || ""}|${traits}|${marks}|${base}`;
}

// Keep the FIRST (highest-ranked) entry per key; order preserved. `keyOf` maps an entry to its dupKey.
export function dedupRanked(ranked, keyOf) {
  const seen = new Set(), out = [];
  for (const x of ranked) { const k = keyOf(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
