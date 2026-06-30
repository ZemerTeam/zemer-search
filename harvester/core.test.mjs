import { test } from "node:test";
import assert from "node:assert/strict";
import { ownsRow } from "./core.mjs";

// The whitelist-purity guard: a harvested shelf/album row is kept only if its OWN artist channel is the
// artist's own (music or regular) channel, or any whitelisted artist's channel. Foreign uploaders (YT
// Music mixes them into the artist's Videos/Songs feed) are dropped. (A row with NO rowArtistId is kept
// by the caller's `s.rowArtistId && !ownsRow(...)` short-circuit — trusted to the page.)
test("ownsRow keeps the artist's own + whitelisted channels, drops foreign uploaders", () => {
  const owned = new Set(["UCartist", "UCregular"]); // this artist's music + regular channels
  const wl = new Set(["UCartist", "UCregular", "UCfeat"]); // all whitelisted channels (incl. a collaborator)
  assert.equal(ownsRow("UCartist", owned, wl), true, "own music channel");
  assert.equal(ownsRow("UCregular", owned, wl), true, "own regular upload channel");
  assert.equal(ownsRow("UCfeat", owned, wl), true, "another whitelisted artist (e.g. a feat. collab)");
  assert.equal(ownsRow("UCgarbage", owned, wl), false, "foreign uploader (Lil Wayne / EG Productions / etc.) dropped");
  assert.equal(ownsRow("UCfeat", owned, null), false, "with no whitelist set, only the artist's own channels are owned");
  assert.equal(ownsRow("UCregular", new Set(["UCartist"]), null), false, "regular channel only owned once added to the set");
});
