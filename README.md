# MW4 Callouts

Shared map callouts for Call of Duty: Modern Warfare 4 (2026). Plain static site: open a map, drop a pin, and everyone else sees it.

## Run locally

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765`. Visitors can read the maps. Only the admin account can add, rename, or delete pins.

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

Pins are rows in Supabase `public.callouts`. Position is a fraction of the image (`x` and `y` from 0 to 1), so it stays put at any zoom. The browser uses the public publishable key in `config.js`. Anyone can read. Insert, update, and delete require a signed-in user whose email is `hello@samquinn.com.au`. That check is RLS on the JWT. The same email in the page is only so the edit controls show up for that account.

The enlarged map has a numbered legend. On a wide screen it sits beside the map. On a phone it stays closed until you open Legend. Hover or tap an entry to highlight its pin, and the map pans to it when it is off screen. New pins show up live.

Admin is a small button in the header and on the map bar. It asks for an email and sends a Supabase magic link (`signInWithOtp`) back to this site's origin and path. The session stays in the browser. A different email can sign in but cannot edit. Sign out is on that same button once a session exists.

In admin mode, drag a pin to move it. The toolbar can also draw a line, an arrow, or a zone in `public.map_drawings` (image fractions, same as pins). Zones show in the legend. Everyone can see drawings. They update live. Undo reverts the last move, drawing, or delete.

On `localhost` or `127.0.0.1` only, `?preview-admin=1` shows that toolbar so the controls can be screenshotted. It does not sign anyone in and it does not write.

`public.callout_votes` is unused. The page does not read or write it.

`vendor/supabase.js` is `@supabase/supabase-js` 2.118.0, using the implicit auth flow so the default magic-link email template works. Fonts are Barlow, under the SIL Open Font License (`fonts/OFL.txt`).

Older rows may still have a gamertag. The page ignores it. Pins and the legend show the callout name only.

For the magic link to return to production, set this in Supabase Authentication → URL Configuration:

| Setting | Value |
| --- | --- |
| Site URL | `https://mw4-map-callouts.vercel.app` |
| Redirect URLs | `https://mw4-map-callouts.vercel.app/**` |

Add `http://127.0.0.1:8765/**` and `http://localhost:8765/**` if you sign in from a local server. The redirect does not include the map hash, because the sign-in tokens use the hash. After the link, open the map again. The first link can create the admin user. After that, you can turn off new sign-ups in the Auth settings if you don't want other people to create accounts.
