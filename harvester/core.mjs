// Shared per-artist harvest used by both the initial harvest and the maintenance refresh. `browse(args)`
// is injected so callers control cache policy (initial = forever-cache; refresh passes landingMaxAgeMs so
// the artist landing + shelf pages re-fetch to catch new releases while immutable album pages stay
// forever-cached) and so a block aborts cleanly (browse throws BlockError; soft errors degrade to {}).
//
// Returns the artist's complete catalog as TYPED ENTITIES: tracks (songs + videos), albums/singles/EPs,
// and playlists — so search can group results by category the way YouTube Music does.
import {
  parseArtistPage, parseArtistItems, parseArtistItemsContinuation, parsePlaylistPage,
} from "../harness/browse.mjs";

export class BlockError extends Error {}

// A harvested shelf/album row "belongs" to the artist iff its OWN artist channel is the artist's own
// (music or regular) channel, or any whitelisted artist's channel. Rows uploaded by non-whitelisted
// channels (YT Music mixes foreign uploads into the artist's Videos/Songs feed) are dropped — same
// whitelist-purity rule community playlists use. A row with no captured artist is trusted to the page.
export const ownsRow = (rowArtistId, owned, whitelist) =>
  owned.has(rowArtistId) || (!!whitelist && whitelist.has(rowArtistId));

export function makeBrowse(postBrowse) {
  return async (args) => {
    const r = await postBrowse(args);
    if (r.blocked) throw new BlockError();
    if (r.networkError || r.error) return {};
    return r.json || {};
  };
}

const yearOf = (s) => { const m = (s || "").match(/\b(19|20)\d\d\b/); return m ? Number(m[0]) : null; };
function albumType(subtitle, sourceTitle) {
  const s = `${subtitle || ""} ${sourceTitle || ""}`.toLowerCase();
  if (/single/.test(s)) return "single";
  if (/\bep\b/.test(s)) return "ep";
  return "album";
}

async function pageChain(browse, first, isVideo, add, onItems) {
  (first.songs || []).forEach(add);
  if (onItems) onItems(first.items || []);
  else (first.items || []).filter((i) => i.kind === "song").forEach(add);
  let cont = first.continuation, guard = 0;
  while (cont && guard++ < 100) {
    const cp = parseArtistItemsContinuation(await browse({ continuation: cont }), isVideo);
    (cp.songs || []).forEach(add);
    if (onItems) onItems(cp.items || []);
    else (cp.items || []).filter((i) => i.kind === "song").forEach(add);
    cont = cp.continuation;
  }
}

// Harvest one artist's catalog → { tracks, albums, playlists, thumbnail }.
//   shallow=false (default, "deep"): COMPLETE discography — paginates every song/video/album shelf.
//   shallow=true: landing page + its carousels + (new) album expansion only — skips deep "more"
//     pagination. New releases surface at the top of the landing carousels, so a shallow pass catches
//     them with ~1 request/artist instead of many. Used by the daily maintenance refresh; the weekly
//     deep refresh and the initial harvest/onboard stay full.
export async function harvestArtist(artist, browse, { landingMaxAgeMs, shallow = false, whitelist = null } = {}) {
  const byId = new Map(); // videoId -> track (dedup; also lets us PREFER VIDEO when a videoId is cross-listed)
  const tracks = [];
  const albums = new Map();    // browseId -> album/single/ep entity
  const playlists = new Map(); // playlistId -> playlist entity
  const owned = new Set([artist.id]); // channels whose rows legitimately belong here (music + regular, added below)
  const add = (s) => {
    if (!s?.videoId || s.videoId.length !== 11) return;
    // Whitelist-purity guard: drop a shelf/album row uploaded by a non-whitelisted channel (YT Music
    // mixes foreign uploads into the artist's Videos/Songs feed). A row with no captured artist is trusted.
    if (s.rowArtistId && !ownsRow(s.rowArtistId, owned, whitelist)) return;
    const ex = byId.get(s.videoId);
    // Same videoId can appear on BOTH the Songs and Videos shelves of one artist — a video is a video, so
    // prefer isVideo=true on re-encounter (cross-artist preference is handled by the upsert's MAX). Also
    // MERGE the detail metadata that lives on different shelves: duration is on the album page, the play
    // count is on the landing "Songs" shelf — fill duration if missing, keep the highest play count.
    if (ex) {
      if (s.isVideo) ex.isVideo = true;
      if (ex.durationSec == null && s.durationSec != null) ex.durationSec = s.durationSec;
      if (s.playCount != null && (ex.playCount == null || s.playCount > ex.playCount)) ex.playCount = s.playCount;
      return;
    }
    const t = {
      videoId: s.videoId, title: s.title, artistId: artist.id, artistName: artist.name,
      isVideo: !!s.isVideo, explicit: !!s.explicit,
      isFemale: !!artist.isFemale, isChasid: !!artist.isChasid, isKidZone: !!artist.isKidZone,
      durationSec: s.durationSec ?? null, playCount: s.playCount ?? null,
    };
    byId.set(s.videoId, t); tracks.push(t);
  };
  const collectEntities = (items, sourceTitle) => {
    for (const it of items) {
      if (it.kind === "album" && it.browseId && !albums.has(it.browseId)) {
        albums.set(it.browseId, {
          id: it.browseId, playlistId: it.playlistId || null, title: it.title,
          type: albumType(it.subtitle, sourceTitle), year: yearOf(it.subtitle), thumbnail: it.thumbnail || null,
        });
      } else if (it.kind === "playlist" && it.playlistId && !playlists.has(it.playlistId)) {
        playlists.set(it.playlistId, { id: it.playlistId, title: it.title, thumbnail: it.thumbnail || null });
      }
    }
  };

  const page = parseArtistPage(await browse({ browseId: artist.id, maxAgeMs: landingMaxAgeMs }));
  if (page.regularChannelId) owned.add(page.regularChannelId); // the artist's own upload channel is always theirs
  const sections = page.sections;

  for (const s of sections) {
    if (s.kind === "songs") s.songs.forEach(add);
    if (s.kind === "carousel") { s.items.filter((i) => i.kind === "song").forEach(add); collectEntities(s.items, s.title); }
  }
  if (!shallow) {
    for (const s of sections) {
      if (!s.moreEndpoint || !/song|video/i.test(s.title)) continue;
      const isVideo = /video/i.test(s.title);
      const j = await browse({ browseId: s.moreEndpoint.browseId, params: s.moreEndpoint.params, maxAgeMs: landingMaxAgeMs });
      await pageChain(browse, parseArtistItems(j, isVideo), isVideo, add, null);
    }
    for (const s of sections) {
      if (s.kind !== "carousel" || !s.moreEndpoint || !/album|single|ep|release|playlist/i.test(s.title)) continue;
      const j = await browse({ browseId: s.moreEndpoint.browseId, params: s.moreEndpoint.params, maxAgeMs: landingMaxAgeMs });
      await pageChain(browse, parseArtistItems(j, false), false, add, (items) => collectEntities(items, s.title));
    }
  }
  const albumTracks = [];
  for (const al of albums.values()) {
    if (!al.playlistId) continue; // expanding album tracks is what makes the harvest a COMPLETE discography
    let pos = 0;
    const albumAdd = (s) => { add(s); if (s?.videoId?.length === 11) albumTracks.push({ albumId: al.id, videoId: s.videoId, pos: pos++ }); };
    await pageChain(browse, parsePlaylistPage(await browse({ browseId: "VL" + al.playlistId })), false, albumAdd, null);
  }

  return { tracks, albums: [...albums.values()], playlists: [...playlists.values()], albumTracks, thumbnail: page.thumbnail, regularChannelId: page.regularChannelId };
}
