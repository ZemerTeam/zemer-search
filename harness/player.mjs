// IP-safe /player layer — the only reliable source of a track's REAL release date. Browse pages carry
// only a year; the player microformat carries the full upload/publish date (ISO-8601). Routed through
// net.mjs (cached/paced/anti-bot circuit breaker) like browse.mjs/search.mjs. Unauthenticated, no
// visitorData (verified to return the date fine — same as our browse/search path).
//
// Used to date RELEASES cheaply: one /player on an album's sample track gives that release's date — we
// never fetch /player per track. See harvester/releases.mjs.
import { CLIENTS, ORIGIN, PLAYER_URL } from "./clients.mjs";
import { cachedPost } from "./net.mjs";

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

export async function postPlayer({ videoId, maxAgeMs, cacheOnly } = {}) {
  const body = { context: CONTEXT, videoId, contentCheckOk: true, racyCheckOk: true };
  return cachedPost(PLAYER_URL, HEADERS, body, { maxAgeMs, cacheOnly });
}

// Full ISO-8601 release date from a /player response microformat (e.g. "2026-05-17T07:33:33-07:00").
export function playerUploadDate(json) {
  return json?.microformat?.microformatDataRenderer?.uploadDate
    ?? json?.microformat?.playerMicroformatRenderer?.uploadDate
    ?? json?.microformat?.playerMicroformatRenderer?.publishDate
    ?? null;
}
