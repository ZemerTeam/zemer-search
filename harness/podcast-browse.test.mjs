// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePodcastPage, parsePodcastContinuation, parseChannelPodcastShelf } from "./podcast-browse.mjs";

// ---- channel "Podcasts" shelf → MPSP show ids (channel-catalog discovery) ----
test("parseChannelPodcastShelf extracts MPSP shows from the Podcasts shelf only", () => {
  const twoRow = (id, name) => ({ musicTwoRowItemRenderer: {
    title: { runs: [{ text: name }] },
    thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `http://t/${id}` }] } } },
    navigationEndpoint: { browseEndpoint: { browseId: id } },
  } });
  const shelf = (title, ...items) => ({ musicCarouselShelfRenderer: {
    header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] } } },
    contents: items,
  } });
  const json = { contents: { some: [
    shelf("Latest episodes", twoRow("MPSPzzz", "an episode-ish thing")), // wrong shelf → ignored
    shelf("Podcasts", twoRow("MPSPaaa", "Show A"), twoRow("MPSPbbb", "Show B"), twoRow("UCnotashow", "not a show")),
  ] } };
  const shows = parseChannelPodcastShelf(json);
  assert.deepEqual(shows.map((s) => s.id), ["MPSPaaa", "MPSPbbb"], "only MPSP items from the Podcasts shelf");
  assert.equal(shows[0].name, "Show A");
  assert.match(shows[0].thumbnail, /MPSPaaa/);
});

// ---- fixture helpers ----------------------------------------------------
const SEP = " • "; // the InnerTube run separator (harness/lib.mjs)
const thumb = (url) => ({ musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url }] } } });
// build a subtitle runs array, inserting the " • " separator run between segments
const subtitle = (...segs) => {
  const runs = [];
  segs.forEach((s, i) => {
    if (i) runs.push({ text: SEP });
    runs.push({ text: s });
  });
  return { runs };
};

const multiRow = ({ videoId, title, thumbUrl, sub }) => ({
  musicMultiRowListItemRenderer: {
    ...(videoId ? { onTap: { watchEndpoint: { videoId } } } : {}),
    ...(title != null ? { title: { runs: [{ text: title }] } } : {}),
    ...(thumbUrl ? { thumbnail: thumb(thumbUrl) } : {}),
    ...(sub ? { subtitle: sub } : {}),
  },
});

const mrlir = ({ videoId, title, thumbUrl, sub }) => ({
  musicResponsiveListItemRenderer: {
    ...(videoId ? { playlistItemData: { videoId } } : {}),
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: title != null ? [{ text: title }] : [] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: sub ?? { runs: [] } } },
    ],
    ...(thumbUrl ? { thumbnail: thumb(thumbUrl) } : {}),
  },
});

// A full twoColumnBrowseResultsRenderer show page.
const showPage = ({ episodes, continuation }) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            sectionListRenderer: {
              contents: [{
                musicResponsiveHeaderRenderer: {
                  title: { runs: [{ text: "The Show" }] },
                  straplineTextOne: {
                    runs: [{
                      text: "Reb Author",
                      navigationEndpoint: { browseEndpoint: { browseId: "UCchannelABC" } },
                    }],
                  },
                  thumbnail: thumb("http://cdn/show.jpg"),
                  secondSubtitle: { runs: [{ text: "312 episodes" }] },
                  subtitle: { runs: [{ text: "Podcast" }, { text: SEP }, { text: "Judaism" }] },
                  description: { musicDescriptionShelfRenderer: { description: { runs: [{ text: "A great show" }] } } },
                },
              }],
            },
          },
        },
      }],
      secondaryContents: {
        sectionListRenderer: {
          contents: [{
            musicShelfRenderer: {
              contents: episodes,
              ...(continuation ? { continuations: [{ nextContinuationData: { continuation } }] } : {}),
            },
          }],
        },
      },
    },
  },
});

// ---- header fields ------------------------------------------------------
test("parsePodcastPage: show header fields (name/author/channelId/thumbnail/categories/description)", () => {
  const { show } = parsePodcastPage(showPage({ episodes: [] }), "MPSPshow1");
  assert.equal(show.id, "MPSPshow1");
  assert.equal(show.name, "The Show");
  assert.equal(show.author, "Reb Author");
  assert.equal(show.channelId, "UCchannelABC");
  assert.equal(show.thumbnail, "http://cdn/show.jpg");
  assert.equal(show.episodeCountText, "312 episodes");
  assert.deepEqual(show.categories, ["Podcast", "Judaism"]); // " • " separator run filtered out
  assert.equal(show.description, "A great show");
});

test("parsePodcastPage: a non-UC channel id is rejected (null)", () => {
  const page = showPage({ episodes: [] });
  page.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
    .sectionListRenderer.contents[0].musicResponsiveHeaderRenderer
    .straplineTextOne.runs[0].navigationEndpoint.browseEndpoint.browseId = "VLnotachannel";
  const { show } = parsePodcastPage(page, "MPSPshow1");
  assert.equal(show.channelId, null);
});

// ---- episode extraction + subtitle order-independence -------------------
test("parsePodcastPage: episode extraction + subtitleMeta order-independence", () => {
  const episodes = [
    multiRow({ videoId: "vidDate", title: "Date only", thumbUrl: "http://cdn/e1.jpg", sub: subtitle("Mar 10") }),
    multiRow({ videoId: "vidBoth", title: "Date and duration", thumbUrl: "http://cdn/e2.jpg", sub: subtitle("Aug 1", "45:00") }),
    multiRow({ videoId: "vidDur", title: "Duration only", sub: subtitle("30:00") }),
  ];
  const { episodes: eps } = parsePodcastPage(showPage({ episodes }), "MPSPshow1");
  assert.equal(eps.length, 3);

  // ["Mar 10"] → publishedText "Mar 10", no duration
  assert.deepEqual(eps[0], {
    videoId: "vidDate", title: "Date only", thumbnail: "http://cdn/e1.jpg",
    durationSec: null, publishedText: "Mar 10",
  });
  // ["Aug 1", " • ", "45:00"] → date "Aug 1", duration 2700 (order-independent, date first)
  assert.deepEqual(eps[1], {
    videoId: "vidBoth", title: "Date and duration", thumbnail: "http://cdn/e2.jpg",
    durationSec: 2700, publishedText: "Aug 1",
  });
  // ["30:00"] → duration 1800, no date
  assert.deepEqual(eps[2], {
    videoId: "vidDur", title: "Duration only", thumbnail: null,
    durationSec: 1800, publishedText: null,
  });
});

test("parsePodcastPage: a 'N views' segment is NOT captured as the publish label", () => {
  const episodes = [
    // some shows carry a view count instead of / alongside a date; it must not masquerade as the date
    multiRow({ videoId: "vidViews", title: "Views then date", sub: subtitle("1,234 views", "Mar 10") }),
    multiRow({ videoId: "vidOnlyViews", title: "Only views", sub: subtitle("65 views") }),
  ];
  const { episodes: eps } = parsePodcastPage(showPage({ episodes }), "MPSPshow1");
  assert.equal(eps[0].publishedText, "Mar 10");      // date wins, not "1,234 views"
  assert.equal(eps[1].publishedText, null);          // only a view count → no publish label
});

test("parsePodcastPage: rows missing videoId or title are dropped", () => {
  const episodes = [
    multiRow({ videoId: "good", title: "Kept", sub: subtitle("Jan 1") }),
    multiRow({ title: "No id", sub: subtitle("Jan 2") }),        // missing videoId → dropped
    multiRow({ videoId: "noTitle", sub: subtitle("Jan 3") }),    // missing title → dropped
  ];
  const { episodes: eps } = parsePodcastPage(showPage({ episodes }), "MPSPshow1");
  assert.equal(eps.length, 1);
  assert.equal(eps[0].videoId, "good");
});

test("parsePodcastPage: exposes the shelf continuation token", () => {
  const { continuation } = parsePodcastPage(
    showPage({ episodes: [multiRow({ videoId: "a", title: "A", sub: subtitle("x") })], continuation: "CTOKEN" }),
    "MPSPshow1",
  );
  assert.equal(continuation, "CTOKEN");
});

// ---- continuation parsing (musicResponsiveListItemRenderer shape) -------
test("parsePodcastContinuation: musicShelfContinuation with musicResponsiveListItemRenderer episodes", () => {
  const json = {
    continuationContents: {
      musicShelfContinuation: {
        contents: [
          mrlir({ videoId: "cvid1", title: "Cont Ep 1", thumbUrl: "http://cdn/c1.jpg", sub: subtitle("May 5", "12:00") }),
          mrlir({ videoId: "cvid2", title: "Cont Ep 2", sub: subtitle("May 6") }),
          mrlir({ title: "no id here" }),   // dropped
        ],
        continuations: [{ nextContinuationData: { continuation: "NEXT2" } }],
      },
    },
  };
  const { episodes, continuation } = parsePodcastContinuation(json);
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes[0], {
    videoId: "cvid1", title: "Cont Ep 1", thumbnail: "http://cdn/c1.jpg",
    durationSec: 720, publishedText: "May 5",
  });
  assert.deepEqual(episodes[1], {
    videoId: "cvid2", title: "Cont Ep 2", thumbnail: null,
    durationSec: null, publishedText: "May 6",
  });
  assert.equal(continuation, "NEXT2");
});

test("parsePodcastContinuation: mrlir videoId can come from the play-button overlay", () => {
  const item = mrlir({ title: "Overlay Ep", sub: subtitle("Jun 1") });
  item.musicResponsiveListItemRenderer.overlay = {
    musicItemThumbnailOverlayRenderer: {
      content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId: "ovid" } } } },
    },
  };
  const { episodes } = parsePodcastContinuation({
    continuationContents: { musicShelfContinuation: { contents: [item] } },
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].videoId, "ovid");
});
