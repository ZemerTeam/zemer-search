// Browse layer for the harvester — POST /youtubei/v1/browse (unauthenticated — no cookie, no
// visitorData; same as search) + faithful ports of the artist-page navigation in YouTube.kt artist()/artistItems()/
// artistItemsContinuation() and pages/ArtistPage.kt. We harvest an artist's OWN page, so every track's
// artist is the page's (whitelisted) artist — we attach that id directly and skip per-row artist
// extraction.
import { CLIENTS, ORIGIN } from "./clients.mjs";
import { cachedPost } from "./net.mjs";
import {
  getItems, getShelfContinuation, getContinuation, thumbnailUrl, videoIdOf, flexRuns,
} from "./lib.mjs";

const C = CLIENTS.find((c) => c.key === "WEB_REMIX");

const HEADERS = {
  "Content-Type": "application/json",
  "X-Goog-Api-Format-Version": "1",
  "X-YouTube-Client-Name": C.clientId,
  "X-YouTube-Client-Version": C.clientVersion,
  "X-Origin": ORIGIN,
  Referer: ORIGIN + "/",
  "User-Agent": C.userAgent,
};
const CONTEXT = { client: { clientName: C.clientName, clientVersion: C.clientVersion, hl: "en", gl: "US" } };

// browse uses browseId/params/continuation in the BODY (search puts continuation in the query).
// Routed through the cached, rate-limited net layer (fetched at most once, ever).
export async function postBrowse({ browseId = null, params = null, continuation = null, maxAgeMs }) {
  const body = { context: CONTEXT, browseId, params, continuation };
  const url = `${ORIGIN}/youtubei/v1/browse?prettyPrint=false`;
  return cachedPost(url, HEADERS, body, { maxAgeMs });
}

const tabContents = (json) =>
  json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

// MRLIR → minimal song. duration left null (filled later if needed). isVideo passed by the section.
function songFromMRLIR(r, isVideo) {
  const id = videoIdOf(r);
  const title = flexRuns(r, 0)?.[0]?.text;
  if (!id || !title) return null;
  // Per-row artist (channel id) — ignored by the artist-page harvest (which attaches the page artist),
  // but used to whitelist-filter playlist tracks, whose rows are by various artists.
  let rowArtistId = null, rowArtistName = null;
  for (let col = 1; col <= 2 && !rowArtistId; col++) {
    for (const run of flexRuns(r, col) || []) {
      const bid = run?.navigationEndpoint?.browseEndpoint?.browseId;
      if (bid && bid.startsWith("UC")) { rowArtistId = bid; rowArtistName = run.text; break; }
    }
  }
  return {
    videoId: id,
    title,
    thumbnail: thumbnailUrl(r.thumbnail),
    explicit: (r.badges || []).some((b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"),
    isVideo: !!isVideo,
    rowArtistId, rowArtistName,
  };
}

// musicTwoRowItemRenderer → either a direct song (videoId) or an album ref (browseId to expand later).
function fromTwoRow(r) {
  const we = r.navigationEndpoint?.watchEndpoint?.videoId;
  const title = r.title?.runs?.[0]?.text;
  if (!title) return null;
  if (we) {
    return { kind: "song", videoId: we, title, thumbnail: thumbnailUrl(r.thumbnailRenderer),
      explicit: (r.subtitleBadges || []).some((b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"), isVideo: false };
  }
  const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
  const playlistId = r.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
    ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId
    ?? r.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
    ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.playlistId;
  const thumbnail = thumbnailUrl(r.thumbnailRenderer);
  const subtitle = (r.subtitle?.runs || []).map((x) => x.text).join(""); // e.g. "Album • 2023" / "Single • 2024"
  if (browseId && browseId.startsWith("MPRE")) return { kind: "album", browseId, playlistId, title, thumbnail, subtitle };
  if (browseId && browseId.startsWith("VL")) return { kind: "playlist", browseId, playlistId: browseId.slice(2), title, thumbnail, subtitle };
  return null;
}

// Artist header image (for the Artists result category). Handles the immersive + visual header shapes.
function artistThumb(json) {
  const h = json?.header?.musicImmersiveHeaderRenderer ?? json?.header?.musicVisualHeaderRenderer;
  return thumbnailUrl(h?.foregroundThumbnail ?? h?.thumbnail);
}

// The artist's REGULAR-upload channel id (from the header subscribe button) — differs from the music
// channel id used by YT Music. Lets us recognise the artist's own uploads (playlist filtering, #108).
function regularChannelId(json) {
  const h = json?.header?.musicImmersiveHeaderRenderer ?? json?.header?.musicVisualHeaderRenderer;
  return h?.subscriptionButton?.subscribeButtonRenderer?.channelId ?? null;
}

// Parse the artist landing page into sections (songs shelf + carousels), each with a moreEndpoint.
export function parseArtistPage(json) {
  const sections = [];
  for (const c of tabContents(json)) {
    if (c.musicShelfRenderer) {
      const sh = c.musicShelfRenderer;
      const title = sh.title?.runs?.[0]?.text ?? "";
      const isVideo = /video/i.test(title);
      sections.push({
        title, kind: "songs",
        songs: getItems(sh.contents).map((r) => songFromMRLIR(r, isVideo)).filter(Boolean),
        moreEndpoint: sh.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint ?? null,
      });
    } else if (c.musicCarouselShelfRenderer) {
      const car = c.musicCarouselShelfRenderer;
      const hdr = car.header?.musicCarouselShelfBasicHeaderRenderer;
      sections.push({
        title: hdr?.title?.runs?.[0]?.text ?? "",
        kind: "carousel",
        items: (car.contents || []).map((it) => it.musicTwoRowItemRenderer && fromTwoRow(it.musicTwoRowItemRenderer)).filter(Boolean),
        moreEndpoint: hdr?.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint ?? null,
      });
    }
  }
  return { sections, thumbnail: artistThumb(json), regularChannelId: regularChannelId(json) };
}

// artistItems(endpoint) result page: grid (twoRow) or musicPlaylistShelf (MRLIR), + continuation.
export function parseArtistItems(json, isVideo) {
  const grid = tabContents(json)[0]?.gridRenderer;
  if (grid) {
    return {
      items: (grid.items || []).map((it) => it.musicTwoRowItemRenderer && fromTwoRow(it.musicTwoRowItemRenderer)).filter(Boolean),
      continuation: getContinuation(grid.continuations) ?? getShelfContinuation(grid.items),
    };
  }
  const shelf = tabContents(json)[0]?.musicPlaylistShelfRenderer;
  return {
    songs: getItems(shelf?.contents).map((r) => songFromMRLIR(r, isVideo)).filter(Boolean),
    continuation: getContinuation(shelf?.continuations) ?? getShelfContinuation(shelf?.contents),
  };
}

// Album / audio-playlist page (browse "VL"+playlistId) → its track list. Albums are surfaced on the
// artist page only as covers; their tracks live behind a separate browse — expanding them is what makes
// the harvest a COMPLETE discography rather than just the Songs shelf. Handles both the newer
// twoColumn layout and the older singleColumn one, and either shelf renderer.
export function parsePlaylistPage(json) {
  const contents =
    json?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents
    ?? json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
    ?? [];
  const shelf = contents.map((c) => c.musicPlaylistShelfRenderer ?? c.musicShelfRenderer).find(Boolean);
  return {
    songs: getItems(shelf?.contents).map((r) => songFromMRLIR(r, false)).filter(Boolean),
    continuation: getContinuation(shelf?.continuations) ?? getShelfContinuation(shelf?.contents),
  };
}

export function parseArtistItemsContinuation(json, isVideo) {
  const cc = json?.continuationContents;
  if (cc?.gridContinuation) {
    return {
      items: (cc.gridContinuation.items || []).map((it) => it.musicTwoRowItemRenderer && fromTwoRow(it.musicTwoRowItemRenderer)).filter(Boolean),
      continuation: getContinuation(cc.gridContinuation.continuations) ?? getShelfContinuation(cc.gridContinuation.items),
    };
  }
  if (cc?.musicPlaylistShelfContinuation) {
    return {
      songs: getItems(cc.musicPlaylistShelfContinuation.contents).map((r) => songFromMRLIR(r, isVideo)).filter(Boolean),
      continuation: getContinuation(cc.musicPlaylistShelfContinuation.continuations) ?? getShelfContinuation(cc.musicPlaylistShelfContinuation.contents),
    };
  }
  const items = json?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
  return {
    songs: getItems(items).map((r) => songFromMRLIR(r, isVideo)).filter(Boolean),
    continuation: getShelfContinuation(items),
  };
}
