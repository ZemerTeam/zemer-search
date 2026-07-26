// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// gotcha #7 rule 2 — "female-owned" community playlist detection, shared so the search path
// (index/categories.mjs) and the home-rows path (corpus/store.mjs) can NEVER drift (a drift = a female leak).
// A community playlist is female-owned — and so must be HIDDEN under allowFemale=false even if it survives on
// a male collab track — when its id is a female artist's OWN playlist, OR its curator name matches a known
// female artist. Each caller builds the two sets from its own source (index docs vs SQL); the matching
// predicate + the name-normalization key live only here.
import { plainTokens } from "./normalize.mjs";

// Normalized key for comparing a curator name to a female artist's name (whole-name, same-script).
export const femaleNameKey = (name) => plainTokens(name).join(" ");

// femalePlaylistIds: Set of playlist ids owned by female artists. femaleNames: Set of femaleNameKey(name)
// over female artists. Returns (c) => boolean, where c has {id, author}.
export const makeFemaleOwned = (femalePlaylistIds, femaleNames) =>
  (c) => femalePlaylistIds.has(c.id) || (!!c.author && femaleNames.has(femaleNameKey(c.author)));
