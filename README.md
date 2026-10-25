# MW4 Callouts

Shared map callouts for Call of Duty: Modern Warfare 4 (2026). Plain static site: open a map, drop a pin, and everyone else sees it.

## Run locally

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765`. The gamertag is stored in `localStorage` under `mw4-callouts-gamertag`.

## Vercel

No build step. `vercel.json` already sets this:

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null`) |
| Build command | empty (skip) |
| Install command | empty (skip) |
| Output directory | `.` (repository root) |

## Maps

Names match the [official launch briefing](https://www.callofduty.com/blog/2026/10/call-of-duty-modern-warfare-4-ready-for-launch-maps-modes) and [mw4camos.com/maps](https://mw4camos.com/maps). The list lives in `maps.json`.

| Map | Mode | Image | Kind |
| --- | --- | --- | --- |
| Cachette | Core 6v6 | Official tac-map guide, 2068² | Overhead |
| Coal | Core 6v6 | Official tac-map guide, 2068² | Overhead |
| Lithium | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Lotus | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Mumbai | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Munition | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Nautical | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Reactor U92 | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Rooftops | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Sentry | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Silkworm | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Transit 213 | Core 6v6 | Official tac-map guide, 2048² | Overhead |
| Shipment | Core 6v6 (October 27, 2026) | mw4camos.com layout, 450×316 | Overhead |
| Imjin Farmland | Ground War 32v32 | mw4camos.com layout, 450×316 | Overhead |
| Wolves Stadium | Ground War 32v32 | mw4camos.com layout, 450×316 | Overhead |
| Forest | Ground War 32v32 | mw4camos.com layout, 450×316 | Overhead |
| Cafe | Gunfight 2v2 | mw4camos.com layout, 450×316 | Overhead |
| Library | Gunfight 2v2 | mw4camos.com layout, 450×316 | Overhead |
| NYC | Gunfight 2v2 | mw4camos.com layout, 450×316 | Overhead |
| Smuggler | Gunfight 2v2 | mw4camos.com layout, 450×316 | Overhead |
| Kill Block | 3v3 / 10v10 | mw4camos.com, 960×540 | Screenshot |

Official interactive tac maps exist for the 12 launch Core maps only. Shipment, Ground War, and Gunfight use the overhead layouts from mw4camos.com (those files are 450×316). Kill Block has no fixed layout, so the image is a screenshot.

## Callouts

Pins are rows in Supabase `public.callouts`. Position is a fraction of the image (`x` and `y` from 0 to 1), so it stays put at any zoom. The browser uses the public publishable key in `config.js`. Anonymous clients can read and insert only. Realtime is subscribed for inserts.

Upvotes live in `public.callout_votes`. Each browser keeps a random `voter_id` in `localStorage` (`mw4-callouts-voter-id`) and can upvote a callout once. The count is on the pin and in the calls list, which is sorted by votes. When pins sit close together, the one with more votes gets the larger, brighter label. Counts update live. Votes cannot be removed from the browser.

`vendor/supabase.js` is `@supabase/supabase-js` 2.118.0. Fonts are Barlow, under the SIL Open Font License (`fonts/OFL.txt`).

A test pin was left on Cachette while checking the live database: **Test Callout** by **Site Test** (near the middle of the map). One upvote from that check is on the pin. Anonymous clients cannot delete rows, so both stay until someone removes them in the Supabase dashboard.
