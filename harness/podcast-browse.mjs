// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Podcast browse parser — faithful port of the app's YouTube.podcast() + pages/PodcastPage.kt.
// A podcast SHOW page is a POST /youtubei/v1/browse on the MPSP… id (reuses harness/browse.mjs postBrowse,
// so it rides the same IP-safe net layer). Episodes are `musicMultiRowListItemRenderer` rows (the
// continuation can also emit `musicResponsiveListItemRenderer`); both shapes are handled.
import { thumbnailUrl, splitBySeparator, parseTime, getContinuation, getShelfContinuation } from "./lib.mjs";

const notSep = (s) => !!s && !/^[\s•·,]+$/.test(s);
const runsText = (o) => (o?.runs || []).map((r) => r.text).join("");

// twoColumn (standard) else singleColumn — the musicResponsiveHeaderRenderer.
function headerOf(json) {
  const two = json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer?.contents?.find((c) => c.musicResponsiveHeaderRenderer)?.musicResponsiveHeaderRenderer;
  const one = json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer?.contents?.find((c) => c.musicResponsiveHeaderRenderer)?.musicResponsiveHeaderRenderer;
  return two ?? one ?? null;
}

// The episode shelf contents, wherever the layout hides them (twoColumn secondaryContents first).
function episodeContents(json) {
  const sec = json?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents;
  const fromSec = sec?.find((c) => c.musicShelfRenderer || c.musicPlaylistShelfRenderer);
  if (fromSec) return fromSec.musicShelfRenderer ?? fromSec.musicPlaylistShelfRenderer;
  const single = json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer?.contents?.find((c) => c.musicShelfRenderer || c.musicPlaylistShelfRenderer);
  return single?.musicShelfRenderer ?? single?.musicPlaylistShelfRenderer ?? null;
}

// The episode subtitle varies by show — "Mar 10", "65 views", "Aug 1 • 45:00", or duration-only. Scan all
// segments: the first that parses as m:ss/h:mm:ss is the DURATION; the first that doesn't is the published
// date/label. Order-independent, so no segment position is assumed (duration is usually absent → /player).
function subtitleMeta(runs) {
  const segs = splitBySeparator(runs || []).map((s) => s?.[0]?.text).filter(Boolean);
  let durationSec = null, publishedText = null;
  for (const t of segs) {
    const d = parseTime(t);
    if (d != null && durationSec == null) durationSec = d;
    // date/label = first non-duration segment that isn't a view count (some shows show "65 views" alongside
    // or instead of a date; don't let it masquerade as the publish label).
    else if (publishedText == null && d == null && !/\bviews?\b/i.test(t)) publishedText = t;
  }
  return { durationSec, publishedText };
}

// musicMultiRowListItemRenderer → episode (the primary podcast episode shape).
function fromMultiRow(r) {
  const videoId = r?.onTap?.watchEndpoint?.videoId;
  const title = r?.title?.runs?.[0]?.text;
  if (!videoId || !title) return null;
  return { videoId, title, thumbnail: thumbnailUrl(r.thumbnail), ...subtitleMeta(r.subtitle?.runs) };
}

// musicResponsiveListItemRenderer → episode (seen in continuations).
function fromMRLIR(r) {
  const videoId = r?.playlistItemData?.videoId
    ?? r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  const title = r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
  if (!videoId || !title) return null;
  return { videoId, title, thumbnail: thumbnailUrl(r.thumbnail),
    ...subtitleMeta(r?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs) };
}

const episodesFrom = (contents) =>
  (contents || [])
    .map((c) => (c.musicMultiRowListItemRenderer ? fromMultiRow(c.musicMultiRowListItemRenderer)
      : c.musicResponsiveListItemRenderer ? fromMRLIR(c.musicResponsiveListItemRenderer) : null))
    .filter(Boolean);

// Parse a podcast SHOW page → { show, episodes, continuation }.
export function parsePodcastPage(json, id) {
  const h = headerOf(json);
  const strap = h?.straplineTextOne?.runs?.[0];
  const channelId = strap?.navigationEndpoint?.browseEndpoint?.browseId;
  const shelf = episodeContents(json);
  const description =
    runsText(h?.description?.musicDescriptionShelfRenderer?.description) ||
    runsText(h?.description) || null;
  const show = {
    id,
    name: h?.title?.runs?.[0]?.text ?? "",
    author: strap?.text ?? null,
    channelId: (channelId && channelId.startsWith("UC")) ? channelId : null,
    thumbnail: thumbnailUrl(h?.thumbnail),
    episodeCountText: h?.secondSubtitle?.runs?.[0]?.text ?? null,
    categories: (h?.subtitle?.runs || []).map((r) => r.text).filter(notSep),
    description: description || null,
  };
  return {
    show,
    episodes: episodesFrom(shelf?.contents),
    continuation: getContinuation(shelf?.continuations) ?? getShelfContinuation(shelf?.contents),
  };
}

// Parse a host-CHANNEL page's "Podcasts" shelf → [{ id:MPSP…, name, thumbnail }]. This is how channel-level
// whitelisting discovers a publisher's whole catalog: the YT Music channel landing carries a "Podcasts"
// carousel of the channel's shows as MPSP ids (valid show ids the harvest can open directly). NOTE the shelf
// is a capped preview (~10); the "more" link routes to an empty Music view for podcast host channels (their
// shows live on the regular YouTube channel), so this captures the full catalog only for channels at/under
// the cap — which is all but the largest few.
export function parseChannelPodcastShelf(json) {
  const out = [];
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const sh = o.musicCarouselShelfRenderer;
    if (sh) {
      const title = sh.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map((r) => r.text).join("");
      if (title === "Podcasts") {
        for (const c of (sh.contents || [])) {
          const r = c.musicTwoRowItemRenderer;
          const id = r?.navigationEndpoint?.browseEndpoint?.browseId;
          if (id && id.startsWith("MPSP") && !seen.has(id)) {
            seen.add(id);
            out.push({ id, name: r.title?.runs?.[0]?.text ?? "", thumbnail: thumbnailUrl(r.thumbnailRenderer) });
          }
        }
      }
    }
    for (const k in o) if (typeof o[k] === "object") walk(o[k]);
  })(json);
  return out;
}

// Parse a podcast episode-shelf continuation page → { episodes, continuation }.
export function parsePodcastContinuation(json) {
  const cc = json?.continuationContents;
  const shelf = cc?.musicShelfContinuation ?? cc?.musicPlaylistShelfContinuation;
  if (shelf) {
    return {
      episodes: episodesFrom(shelf.contents),
      continuation: getContinuation(shelf.continuations) ?? getShelfContinuation(shelf.contents),
    };
  }
  const items = json?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
  return { episodes: episodesFrom(items), continuation: getShelfContinuation(items) };
}
