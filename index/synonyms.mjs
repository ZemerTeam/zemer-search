// Synonym groups — for equivalences the consonant skeleton can't infer: abbreviations, acronyms, and
// nicknames (e.g. "MBD" ↔ "Mordechai Ben David"). Each group is a list of equivalent surface forms; at
// compile time we precompute the union of plain + skeleton tokens across the group, and at query time a
// query that hits ANY token of a group is expanded with ALL of the group's tokens. User-curated and
// data-driven (data/synonyms.json) — seeded conservatively with only well-known aliases.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plainTokens, skeletonTokens } from "./normalize.mjs";

export const SYNONYMS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/synonyms.json");
export const loadDefaultSynonyms = () => loadSynonyms(SYNONYMS_PATH);

export function compileSynonyms(groups) {
  return (groups || []).filter((g) => Array.isArray(g) && g.length >= 2).map((forms) => {
    const plain = new Set(), skel = new Set();
    for (const f of forms) {
      plainTokens(f).forEach((t) => plain.add(t));
      skeletonTokens(f).forEach((t) => skel.add(t));
    }
    return { plain: [...plain], skel: [...skel] };
  });
}

export function loadSynonyms(file) {
  try { return compileSynonyms(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { return []; }
}

// Expand original query token sets with any synonym group the query overlaps. Returns new arrays.
export function expandQuery(qPlain, qSkel, syns) {
  const plain = new Set(qPlain), skel = new Set(qSkel);
  for (const g of syns) {
    if (g.plain.some((t) => plain.has(t)) || g.skel.some((t) => skel.has(t))) {
      g.plain.forEach((t) => plain.add(t));
      g.skel.forEach((t) => skel.add(t));
    }
  }
  return { plain: [...plain], skel: [...skel] };
}
