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
    community: pick(cats.community, (p) => ({ id: p.id, title: p.title, artist: p.artistName, thumbnail: p.thumbnail, source: "community", whitelisted: p.whitelisted })), // respect k (chip → up to 100), not capped at 6
  };
}
