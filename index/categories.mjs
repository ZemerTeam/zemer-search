// Grouped (categorized) search — Artists / Songs / Albums / Singles / Videos / Playlists, the way
// YouTube Music presents results. Builds one in-memory index per category from the corpus entities
// (each "doc" shaped {title, artistName, ...payload} so buildIndex/search work unchanged) and returns
// top-k per category with content-filter scoping.
import { buildIndex, search } from "./search.mjs";

export function buildCategories({ tracks = [], artists = [], albums = [], playlists = [], community = [] }, synonyms = []) {
  const songs = tracks.filter((t) => !t.isVideo);
  const videos = tracks.filter((t) => t.isVideo);
  const artistDocs = artists.map((a) => ({ ...a, title: a.name, artistName: "" }));
  return {
    artists: buildIndex(artistDocs, synonyms),
    songs: buildIndex(songs, synonyms),
    albums: buildIndex(albums.filter((a) => a.type !== "single"), synonyms),
    singles: buildIndex(albums.filter((a) => a.type === "single"), synonyms),
    videos: buildIndex(videos, synonyms),
    playlists: buildIndex(playlists, synonyms),       // artist-owned playlists
    community: buildIndex(community, synonyms),        // community-curated playlists (own chip)
  };
}

// Content filters apply ONLY when explicitly requested; an unset flag means no filtering (so a caller
// that omits allowFemale gets everyone, not silently zero female artists). blockVideos removes videos;
// allowFemale=false / kidZone=true gate every entity via its artist's flags.
const allowed = (t, o) => (o.allowFemale === false ? !t.isFemale : true) && (o.kidZoneOnly ? t.isKidZone : true) && (o.blockVideos ? !t.isVideo : true);

// A community playlist survives the content filter iff ≥1 of its whitelisted members would survive (same
// rule the /community list + /playlist serve-time filter use), so an ALL-female list is hidden when female
// is blocked, an all-video list when videos are blocked, etc. `clsMask` packs which (isFemale,isVideo,
// isKidZone) member classes are present; `fb` = has a member not yet in the corpus (unknown → always kept).
// Fail-open when there's no class data (a real playlist always has ≥1 member).
function communitySurvives(p, o) {
  if (o.allowFemale !== false && !o.kidZoneOnly && !o.blockVideos) return true; // no filter active
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
  const pick = (idx, map, n = k) =>
    search(idx, q, n * 4).map((r) => r.track).filter((t) => allowed(t, o)).slice(0, n).map(map);
  const albumRow = (a) => ({ id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artistName, year: a.year, thumbnail: a.thumbnail });
  return {
    artists: pick(cats.artists, (a) => ({ id: a.id, name: a.name, thumbnail: a.thumbnail }), 6),
    songs: pick(cats.songs, (t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit })),
    albums: pick(cats.albums, albumRow, 6),
    singles: pick(cats.singles, albumRow, 6),
    videos: pick(cats.videos, (t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit }), 6),
    playlists: pick(cats.playlists, (p) => ({ id: p.id, title: p.title, artist: p.artistName, thumbnail: p.thumbnail, source: p.source || "artist", whitelisted: p.whitelisted }), 6),
    // title-only ranking; curator kept for display; respects k (not capped at 6). Hides community playlists
    // with no track surviving the content filter (all-female list when female is blocked, etc.).
    community: search(cats.community, q, k * 4).map((r) => r.track).filter((p) => communitySurvives(p, o)).slice(0, k)
      .map((p) => ({ id: p.id, title: p.title, artist: p.author || "", thumbnail: p.thumbnail, source: "community", whitelisted: p.whitelisted })),
  };
}
