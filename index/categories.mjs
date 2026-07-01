// Grouped (categorized) search — Artists / Songs / Albums / Singles / Videos / Playlists, the way
// YouTube Music presents results. Builds one in-memory index per category from the corpus entities
// (each "doc" shaped {title, artistName, ...payload} so buildIndex/search work unchanged) and returns
// top-k per category with content-filter scoping.
import { buildIndex, search } from "./search.mjs";
import { buildFemaleMatcher, isFemaleInvolved } from "./credits.mjs";
import { plainTokens } from "./normalize.mjs";

// Each entity doc carries `femaleInvolved` — true when its PRIMARY artist is female OR any credited
// (featured) artist matches a known female (see credits.mjs). The content filter uses this instead of the
// primary-only `isFemale` so a male-primary track that features a female is dropped under allowFemale=0.
// `matcher` may be passed (the server builds it once for its SQL paths too); else it's built here. Tracks
// may arrive with `femaleInvolved` precomputed (server path) — reused as-is.
export function buildCategories({ tracks = [], artists = [], albums = [], playlists = [], community = [] }, synonyms = [], matcher = null) {
  const m = matcher || buildFemaleMatcher(artists);
  const femaleVideoIds = new Set();
  const tdoc = (t) => {
    const fi = t.femaleInvolved !== undefined ? t.femaleInvolved : isFemaleInvolved(t.title, t.artistName, t.isFemale, m);
    if (fi) femaleVideoIds.add(t.videoId);
    return t.femaleInvolved !== undefined ? t : { ...t, femaleInvolved: fi };
  };
  const enriched = tracks.map(tdoc);
  const songs = enriched.filter((t) => !t.isVideo);
  const videos = enriched.filter((t) => t.isVideo);
  const albumDocs = albums.map((a) => ({ ...a, femaleInvolved: a.isFemale || isFemaleInvolved(a.title, a.artistName, a.isFemale, m) }));
  const artistDocs = artists.map((a) => ({ ...a, title: a.name, artistName: "", femaleInvolved: a.isFemale }));
  const playlistDocs = playlists.map((p) => ({ ...p, femaleInvolved: p.isFemale })); // artist-owned: the owner's gender
  // A community playlist that IS a female artist's own playlist (same id as a female-owned artist playlist,
  // or curated under a female artist's name) is female-owned — member-survival alone would keep it alive on a
  // few male collab tracks, so flag it to hide when female is blocked. (Caught a real leak: "DJ Kraz - Complete
  // Collection" surviving on 4 non-female members.)
  const femaleOwnedPl = new Set(playlists.filter((p) => p.isFemale).map((p) => p.id));
  const femaleNames = new Set(artists.filter((a) => a.isFemale && a.name).map((a) => plainTokens(a.name).join(" ")));
  const communityDocs = community.map((c) => ({ ...c, femaleOwned: femaleOwnedPl.has(c.id) || (!!c.author && femaleNames.has(plainTokens(c.author).join(" "))) }));
  const cats = {
    artists: buildIndex(artistDocs, synonyms),
    songs: buildIndex(songs, synonyms),
    albums: buildIndex(albumDocs.filter((a) => a.type !== "single"), synonyms),
    singles: buildIndex(albumDocs.filter((a) => a.type === "single"), synonyms),
    videos: buildIndex(videos, synonyms),
    playlists: buildIndex(playlistDocs, synonyms),    // artist-owned playlists
    community: buildIndex(communityDocs, synonyms),    // community-curated playlists (own chip)
  };
  cats.femaleVideoIds = femaleVideoIds; // for the server's SQL paths (temp _female); harmless elsewhere
  return cats;
}

// Content filters apply ONLY when explicitly requested; an unset flag means no filtering (so a caller
// that omits allowFemale gets everyone, not silently zero female artists). blockVideos removes videos;
// allowFemale=false / kidZone=true gate every entity via its artist's flags.
const allowed = (t, o) => (o.allowFemale === false ? !(t.femaleInvolved ?? t.isFemale) : true) && (o.kidZoneOnly ? t.isKidZone : true) && (o.blockVideos ? !t.isVideo : true);

// Server-curated id overrides (mirrors the app's `blockedContentIds`): an id listed `global` is dropped for
// everyone; `female` only when female is blocked. Matched against a result's videoId / id (channelId or
// browseId) / playlistId — one flat list covers every entity type. `b` = cats.blocked = {global, female} Sets
// (undefined → no-op). This is the curated patch for what auto-detection can't catch (e.g. a women's playlist
// that survives on one token male track, or a female collaborator not named in a track's text).
const blockedDoc = (d, o, b) => {
  if (!b) return false;
  for (const id of [d.videoId, d.id, d.playlistId]) {
    if (id && (b.global.has(id) || (o.allowFemale === false && b.female.has(id)))) return true;
  }
  return false;
};

// A community playlist survives the content filter iff ≥1 of its whitelisted members would survive (same
// rule the /community list + /playlist serve-time filter use), so an ALL-female list is hidden when female
// is blocked, an all-video list when videos are blocked, etc. `clsMask` packs which (isFemale,isVideo,
// isKidZone) member classes are present; `fb` = has a member not yet in the corpus (unknown → always kept).
// Fail-open when there's no class data (a real playlist always has ≥1 member).
function communitySurvives(p, o) {
  if (o.allowFemale !== false && !o.kidZoneOnly && !o.blockVideos) return true; // no filter active
  if (p.femaleOwned && o.allowFemale === false) return false; // a female artist's OWN playlist → hide (don't survive on male collabs)
  if (p.fb) return true;
  const mask = p.clsMask | 0;
  if (!mask) return true; // no data → don't hide
  for (let c = 0; c < 8; c++) {
    if (!(mask & (1 << c))) continue;
    const female = (c >> 2) & 1, video = (c >> 1) & 1, kidzone = c & 1;
    const excluded = (female && o.allowFemale === false) || (video && o.blockVideos) || (!kidzone && o.kidZoneOnly);
    if (!excluded) return true;
  }
  return false;
}

export function searchCategories(cats, q, o = {}) {
  const k = o.k || 8;
  const b = cats.blocked; // server-curated id overrides (global/female); undefined → no-op
  const pick = (idx, map, n = k) =>
    search(idx, q, n * 4).map((r) => r.track).filter((t) => allowed(t, o) && !blockedDoc(t, o, b)).slice(0, n).map(map);
  const albumRow = (a) => ({ id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artistName, year: a.year, thumbnail: a.thumbnail });
  return {
    // every category honors the requested k (filter-then-slice in pick); the app sends k=8 for the "All"
    // summary and k=100 per filter chip, so each chip isn't pinned at a tiny cap.
    artists: pick(cats.artists, (a) => ({ id: a.id, name: a.name, thumbnail: a.thumbnail })),
    songs: pick(cats.songs, (t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit, durationSec: t.durationSec ?? null, playCount: t.playCount ?? null })),
    albums: pick(cats.albums, albumRow),
    singles: pick(cats.singles, albumRow),
    videos: pick(cats.videos, (t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit, durationSec: t.durationSec ?? null, playCount: t.playCount ?? null })),
    playlists: pick(cats.playlists, (p) => ({ id: p.id, title: p.title, artist: p.artistName, thumbnail: p.thumbnail, source: p.source || "artist", whitelisted: p.whitelisted })),
    // title-only ranking; curator kept for display; respects k (not capped at 6). Hides community playlists
    // with no track surviving the content filter (all-female list when female is blocked, etc.).
    community: search(cats.community, q, k * 4).map((r) => r.track).filter((p) => communitySurvives(p, o) && !blockedDoc(p, o, b)).slice(0, k)
      .map((p) => ({ id: p.id, title: p.title, artist: p.author || "", thumbnail: p.thumbnail, source: "community", whitelisted: p.whitelisted })),
  };
}
