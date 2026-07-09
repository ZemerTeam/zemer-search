// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// IP-safe /player layer — the only reliable source of a track's REAL release date. Browse pages carry
// only a year; the player microformat carries the full upload/publish date (ISO-8601). Routed through
// net.mjs (cached/paced/anti-bot circuit breaker) like browse.mjs/search.mjs. Unauthenticated, no
// visitorData (verified to return the date fine — same as our browse/search path).
//
// Used to date RELEASES cheaply: one /player on an album's sample track gives that release's date — we
// never fetch /player per track. See harvester/releases.mjs.
import { CLIENTS, ORIGIN, PLAYER_URL } from "./clients.mjs";
import { cachedPost } from "./net.mjs";

// Client is selectable: WEB_REMIX (YouTube Music, the default) can't see many regular-YouTube uploads
// (LOGIN_REQUIRED / no microformat) — the plain WEB client returns the exact date for those (verified:
// gated music videos, standalone audio, and album art tracks all date via WEB when WEB_REMIX won't).
// A different client = a different request body = its own cache entry, so fallbacks never mix in the cache.
const clientOf = (key) => {
  const C = CLIENTS.find((c) => c.key === key);
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Format-Version": "1",
      "X-YouTube-Client-Name": C.clientId,
      "X-YouTube-Client-Version": C.clientVersion,
      "X-Origin": ORIGIN,
      Referer: ORIGIN + "/",
      "User-Agent": C.userAgent,
    },
    context: { client: { clientName: C.clientName, clientVersion: C.clientVersion, hl: "en", gl: "US" } },
  };
};

export async function postPlayer({ videoId, client = "WEB_REMIX", maxAgeMs, cacheOnly } = {}) {
  const C = clientOf(client);
  const body = { context: C.context, videoId, contentCheckOk: true, racyCheckOk: true };
  return cachedPost(PLAYER_URL, C.headers, body, { maxAgeMs, cacheOnly });
}

// Full ISO-8601 release date from a /player response microformat (e.g. "2026-05-17T07:33:33-07:00").
export function playerUploadDate(json) {
  return json?.microformat?.microformatDataRenderer?.uploadDate
    ?? json?.microformat?.playerMicroformatRenderer?.uploadDate
    ?? json?.microformat?.playerMicroformatRenderer?.publishDate
    ?? null;
}
