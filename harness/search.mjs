// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// IP-safe search layer used for DISCOVERY (community-playlist harvesting). The app's faithful search port
// lives in lib.mjs (a raw `fetch`, byte-for-byte with the Kotlin, for the parity self-test); THIS module
// is the harvester's search and routes through net.mjs — the same gzip disk cache + rate-paced limiter +
// anti-bot circuit breaker as browse.mjs (gotcha #12: every live YouTube request goes through net.mjs).
// It parses the result shelf LENIENTLY: discovery only needs a playlist's id + title, so we keep every
// real playlist row instead of dropping ones missing an app-required field (max yield).
import { CLIENTS, ORIGIN } from "./clients.mjs";
import { cachedPost } from "./net.mjs";
import { getItems, getContinuation, getShelfContinuation, flexRuns, thumbnailUrl, isPlaylist, FILTERS } from "./lib.mjs";

export { FILTERS }; // re-export so the harvester gets the SearchFilter params from one place

const C = CLIENTS.find((c) => c.key === "WEB_REMIX");
const HEADERS = {
  "Content-Type": "application/json",
  "X-Goog-Api-Format-Version": "1",
  "X-YouTube-Client-Name": C.clientId,
  "X-YouTube-Client-Version": C.clientVersion,
  "X-Origin": ORIGIN,
  Referer: ORIGIN + "/",
  "User-Agent": C.userAgent,
  // deliberately no cookie, no Authorization, no visitorData (setLogin=false) — search is unauthenticated
};
const CONTEXT = { client: { clientName: C.clientName, clientVersion: C.clientVersion, hl: "en", gl: "US" } };

// POST /search through the IP-safe cache. Fresh search: { query, params }. Page: { continuation } (sent as
// BOTH the `continuation` and `ctoken` query params with a null body query — exactly as the app does).
export async function postSearch({ query = null, params = null, continuation = null, maxAgeMs } = {}) {
  const url = new URL(`${ORIGIN}/youtubei/v1/search`);
  url.searchParams.set("prettyPrint", "false");
  if (continuation) { url.searchParams.set("continuation", continuation); url.searchParams.set("ctoken", continuation); }
  return cachedPost(url.toString(), HEADERS, { context: CONTEXT, query, params }, { maxAgeMs });
}

// Result-shelf rows + continuation from EITHER a first-page response (tabbedSearchResultsRenderer) OR a
// continuation page (musicShelfContinuation). Returns raw MRLIR rows for the caller to map.
export function parseSearchShelf(json) {
  const sections =
    json?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
    ?? json?.contents?.sectionListRenderer?.contents ?? [];
  const shelf = sections.map((c) => c.musicShelfRenderer).find(Boolean)
    ?? json?.continuationContents?.musicShelfContinuation ?? null;
  if (!shelf) return { rows: [], continuation: null };
  return {
    rows: getItems(shelf.contents),
    continuation: getContinuation(shelf.continuations) ?? getShelfContinuation(shelf.contents),
  };
}

// Lenient playlist row → { id, title, author, thumbnail }. Unlike parsers.toYTItem (which drops a playlist
// if any app-required field — shuffle/radio endpoint, song-count — is absent), discovery only needs the id
// + a title, so we keep every real playlist row. Non-playlist rows return null.
export function playlistFromRow(r) {
  if (!isPlaylist(r)) return null;
  const bid = r.navigationEndpoint?.browseEndpoint?.browseId ?? null;
  const id = bid?.startsWith("VL") ? bid.slice(2) : bid; // a playlist's browseId is "VL"+playlistId
  const title = flexRuns(r, 0)?.[0]?.text ?? null;
  if (!id || !title) return null;
  const sec = flexRuns(r, 1) || [];
  // author: the first run that links to a channel, else the first text run (e.g. "Author • N songs")
  const author = sec.find((run) => run?.navigationEndpoint?.browseEndpoint?.browseId)?.text ?? sec[0]?.text ?? null;
  return { id, title, author, thumbnail: thumbnailUrl(r.thumbnail) };
}
