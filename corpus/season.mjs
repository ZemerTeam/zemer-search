// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Hebrew-calendar season gates — the single source of truth for seasonal content windows, shared by the
// auto-playlists generator (the seasonal Acapella Top 50) and the store's playlist loader (curated
// playlists marked `"season": "three-weeks"` in data/zemer-playlists.json). Computed from the HEBREW
// calendar via Intl (offline), so windows recur correctly every year despite shifting Gregorian dates.
// Day granularity (civil dates in Brooklyn; the Hebrew day rolls at sunset, so a boundary can be off by
// an evening — fine for a day-based content gate).

export function hebDate(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-u-ca-hebrew", { month: "long", day: "numeric", timeZone: "America/New_York" }).formatToParts(d);
  return { month: p.find((x) => x.type === "month")?.value || "", day: +(p.find((x) => x.type === "day")?.value) };
}

// The Three Weeks: 17 Tammuz through 9 Av (Tisha b'Av), when observant Jews listen to acapella only.
// NINE_DAYS=1 narrows the window to 1–9 Av.
export function inThreeWeeks(d = new Date()) {
  const { month, day } = hebDate(d);
  const isTammuz = /^tam+uz$/i.test(month), isAv = month === "Av"; // ICU spells it "Tamuz"; match defensively
  if (process.env.NINE_DAYS === "1") return isAv && day <= 9;
  return (isTammuz && day >= 17) || (isAv && day <= 9);
}

// Is the named season gate currently OPEN? `ACAPELLA_SEASON=on|off` force-overrides the three-weeks gate
// (testing / rabbinic call) — the same knob the generator has always honored. An entry with an UNKNOWN
// season name is treated as always-on (fail-open: a typo must never vanish a curated playlist).
export function seasonActive(name, d = new Date()) {
  if (name === "three-weeks") {
    const env = (process.env.ACAPELLA_SEASON || "auto").toLowerCase();
    return env === "on" ? true : env === "off" ? false : inThreeWeeks(d);
  }
  return true;
}
