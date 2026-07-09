// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

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
export async function postBrowse({ browseId = null, params = null, continuation = null, maxAgeMs, cacheOnly }) {
  const body = { context: CONTEXT, browseId, params, continuation };
  const url = `${ORIGIN}/youtubei/v1/browse?prettyPrint=false`;
  return cachedPost(url, HEADERS, body, { maxAgeMs, cacheOnly });
}

const tabContents = (json) =>
  json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

// "3:45" → 225 ; "1:02:03" → 3723 ; null if not m:ss / h:mm:ss.
export function parseDurationSec(t) {
  const m = String(t || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  return m ? (m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + +m[3] : null;
}
// "74 plays" / "1.2M plays" / "1,234 plays" → 74 / 1200000 / 1234 ; null if not a play count.
export function parsePlays(t) {
  const m = String(t || "").match(/([\d.,]+)\s*([KMB]?)\s*plays?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return isNaN(n) ? null : Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1));
}
const fixedText = (r) => (r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs || []).map((x) => x.text).join("");

// MRLIR → minimal song, + duration (fixed column) + play count (a "N plays" flex run) when the row carries
// them (both are already in the cached page — the landing "Songs" shelf has plays, album pages have durations).
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
  let playCount = null;
  for (let col = 1; col <= 3 && playCount == null; col++) for (const run of flexRuns(r, col) || []) { const p = parsePlays(run?.text); if (p != null) { playCount = p; break; } }
  return {
    videoId: id,
    title,
    thumbnail: thumbnailUrl(r.thumbnail),
    explicit: (r.badges || []).some((b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"),
    isVideo: !!isVideo,
    rowArtistId, rowArtistName,
    durationSec: parseDurationSec(fixedText(r)), playCount,
  };
}

// musicTwoRowItemRenderer → either a direct song (videoId) or an album ref (browseId to expand later).
function fromTwoRow(r) {
  const we = r.navigationEndpoint?.watchEndpoint?.videoId;
  const title = r.title?.runs?.[0]?.text;
  if (!title) return null;
  if (we) {
    // Per-row artist (channel id) from the subtitle — so the harvest can drop carousel songs whose
    // uploader isn't whitelisted (YT Music's artist "Videos" carousel mixes in foreign-channel uploads).
    let rowArtistId = null, rowArtistName = null;
    for (const run of r.subtitle?.runs || []) {
      const bid = run?.navigationEndpoint?.browseEndpoint?.browseId;
      if (bid && bid.startsWith("UC")) { rowArtistId = bid; rowArtistName = run.text; break; }
    }
    return { kind: "song", videoId: we, title, thumbnail: thumbnailUrl(r.thumbnailRenderer),
      explicit: (r.subtitleBadges || []).some((b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"),
      isVideo: false, rowArtistId, rowArtistName };
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
