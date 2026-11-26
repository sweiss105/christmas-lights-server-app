# xmas-lights

Spatial Christmas light controller for xmas.weiss-audio.com. It renders effects in 3D space across about 2900 pixels and streams them over DDP to two GLEDOPTO GL-C-618WL (WLED) controllers.

**Status:** Phases 1 and 2 (engine, DDP, REST API, web UI, WLED effects, show automation) are done and running on the porch, which has one controller (1101 LEDs) so far. Camera mapping (Phase 3) is built and still being tried on the real lights. Home Assistant is linked. See [docs/HANDOFF.md](docs/HANDOFF.md) for the current state and [docs/PLAN.md](docs/PLAN.md) for the phases.

## Layout

```
packages/engine   Effects, layout model and layer compositor. Pure TypeScript, so the server and browser preview share it.
packages/server   40 fps output loop, DDP sender, WLED client and mDNS discovery, REST API (Fastify); serves the web UI at /
packages/web      Web UI (React, React Three Fiber): 3D preview running the same engine in the browser, scenes, Blind/Live, Go
config/example.json   Sample layout (2 controllers × 1450 px), scenes and output settings
```

## Run

```sh
npm install
npm test               # engine, server (incl. DDP end-to-end against a fake WLED receiver) and web unit tests
npm run build:web      # builds packages/web/dist, which the server serves at /
npm start              # http://localhost:8080; state is saved to config/local.json
npm run e2e            # browser smoke test against a throwaway server (needs playwright + Chromium; see scripts/e2e-smoke.mjs)
npm run dev:web        # UI dev server on :5173 with hot reload, proxying /api to XMAS_API (default http://127.0.0.1:8090)
```

On the home server use `docker compose up -d --build`. It needs host networking, because mDNS and DDP must reach the LAN. State lives in `./data/show.json`. Host networking shares the host's ports, so if 8080 is taken, set `XMAS_PORT` (for example `XMAS_PORT=8090`) in `.env`.

Environment variables:

| Var | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `HOST` (`XMAS_HOST` in Docker) | 0.0.0.0 | Address to listen on. `127.0.0.1` keeps the LAN out when cloudflared runs on the same machine |
| `XMAS_CONFIG` | `config/local.json` | State file; on first run it starts from `config/example.json` |
| `XMAS_WEB_ROOT` | `packages/web/dist` | Built web UI served at `/` |
| `XMAS_TZ` (Docker) / `TZ` | UTC | Time zone for Scrolling Text's `#TIME`/`#DATE` tokens, e.g. `America/Chicago` |
| `XMAS_API_TOKEN` | unset | Requires the token on every `/api` route except `/api/health` and `/api/login`: scripts send `Authorization: Bearer <token>`, and the web UI asks for it once and keeps it in a cookie. **Set this or put Cloudflare Access in front before you expose the site through cloudflared.** |
| `XMAS_MQTT_URL` | unset | MQTT broker for Home Assistant, e.g. `mqtt://10.10.1.5:1883`. Unset: no Home Assistant link. See [Home Assistant](#home-assistant) |
| `XMAS_MQTT_USERNAME`, `XMAS_MQTT_PASSWORD` | unset | The MQTT user the app signs in as (the password is never logged) |
| `XMAS_MQTT_DISCOVERY_PREFIX` | `homeassistant` | Home Assistant's MQTT discovery prefix |
| `XMAS_MQTT_TOPIC` | `xmas` | Base topic for state and commands; also makes the entity ids unique |

## Home Assistant

The porch can show up in Home Assistant as a device called **Porch Lights**, with no YAML: the app talks to Home Assistant's MQTT broker and announces itself (MQTT discovery).

### Setup

1. In Home Assistant, if you don't already have an MQTT broker: *Settings → Add-ons → Add-on store → Mosquitto broker → Install*, then *Start* (turn on *Start on boot*).
2. Add the MQTT integration if Home Assistant hasn't offered it already: *Settings → Devices & services → Add integration → MQTT*, and accept the Mosquitto broker it finds.
3. Create a user for the app to sign in with: *Settings → People → Users → Add user* (turn on *Advanced mode* in your profile if you don't see Users), e.g. name `xmas-lights`, a long password, and *Can only log in from the local network*. Mosquitto accepts Home Assistant users.
4. On the server that runs the lights, add to the `.env` next to `docker-compose.yml` (use Home Assistant's IP address; the broker listens on port 1883):
   ```
   XMAS_MQTT_URL=mqtt://10.10.1.5:1883
   XMAS_MQTT_USERNAME=xmas-lights
   XMAS_MQTT_PASSWORD=the-password
   ```
5. Restart the container: `docker compose up -d`. The log says `home assistant: connected to MQTT broker …`, and the app's health bar at the bottom shows *Home Assistant linked*.
6. In Home Assistant, *Settings → Devices & services → MQTT → Devices* now lists **Porch Lights**. Add it to a dashboard, or use its entities in automations.

If the broker is down or the password is wrong, the lights carry on as normal: the app keeps retrying every few seconds and logs why it can't connect.

### What appears

| Entity | What it does |
|---|---|
| **Porch Lights** (light) | Off = Blackout: the porch goes dark but stays under the app's control. On = turns streaming on and puts back the last scene that was on (or the first scene). Brightness is the app's master brightness. |
| **Scene** (select) | Lists the scenes as the app does. Choosing one is the app's Go (with its fade), and stops a playing playlist. Shows the scene on the porch, or nothing when blacked out. |
| **Playlist** (select) | `(none)` plus your playlists. Choosing one plays it; `(none)` stops it (the scene on stage stays on). |
| **App controls porch** (switch) | The app's streaming switch. On: the app drives the porch. Off: the porch is handed back to the WLED controller's own playlist. |
| **Now showing** (sensor) | The scene on the porch, `Off` when blacked out, or `WLED playlist` when the app isn't controlling the porch. |
| **Controller** (connectivity, diagnostic) | Whether the WLED controller answers the app's health checks. |

**Turning the light on also turns streaming on** (*App controls porch*), so the porch follows the app. The scene and playlist pickers don't: with streaming off they change what the app has on stage, which shows as soon as streaming is turned on (by the light, the switch or the nightly schedule). Turning the light off is a blackout; the app keeps control of the porch.

Scenes and playlists added, renamed or deleted in the app show up in the selects straight away. Everything goes through the same code as the app's own buttons, so fades, playlists, the schedule and saving work the same either way. Home Assistant shows the device as unavailable when the app is stopped or can't be reached.

## WLED setup (each controller)

1. Set the LED count under *Settings → LED Preferences* to match `pixelCount` in the layout.
2. Leave *Settings → Sync Interfaces → Realtime → Receive UDP realtime* on. DDP listens on UDP 4048.
3. Save a preset (for example ID 1, warm white) and set it as `fallbackPreset`. The server loads it when streaming stops or the server shuts down cleanly. If the server dies, WLED leaves realtime mode by itself after its timeout (2.5 s by default).
4. If WLED is gamma-correcting realtime data, set `gamma` to 1 via `PATCH /api/output` so it isn't applied twice.

## Web UI

Open the server's address in a browser (xmas.weiss-audio.com behind Cloudflare Access, or `http://<server>:8090` at home). It's built for desktop and tablet, with a phone layout too.

Three pages, switched at the top left (each has its own address, so a bookmark opens it):

- **Control** (`#/control`, where the app opens): the porch live in 3D, what's on it and the playlist's next change, **Stop playlist**, and the library: **Scenes** (search, **Go**, **Edit** in Create, and ⋯ for Duplicate, Rename and Delete), **Playlists** and the nightly **Schedule**. **Full-screen display** (`#/watch`) shows only the live porch, for a tablet or a TV.
- **Create** (`#/create`): designing scenes, with a tool rail like Photoshop's: **Move** (V) shows the scene's layers and the selected layer's settings, **Select** (M) picks lights and saves groups, **Brush** (B) and **Eraser** (E) paint. Each tool's settings open in a small pop-out beside its rail button (click the tool again, its ×, or Esc to close it; drag its header to move it anywhere, double-click the header to put it back). Hold the Space bar with Select, Brush or Eraser to move the view for a moment; let go and you're back on the tool. On a phone or tablet the round button at the bottom right of the view does the same while you hold it. The panel on the right keeps the work (layers, effects, colours; the paint colours and painted layers with the Brush) and can be tucked away to give the 3D view the room. The top bar has the scene (a searchable picker), **Save**, **Save as new…**, Revert, Undo/Redo, **Blind / Live** and **Go**.
- **Setup** (`#/setup`): one-off things, each with its own panel: **Strings** (the layout editor), **House** (the house model), **Map** (camera mapping; `#map` still opens the filming screen), **WLED** (the controllers), **Backups** and **Home** (Home Assistant and the schedule's place and time zone).

The light at the top left says which mode you're in, with its name beside it: green on Control, blue in Create Blind, red in Create Live, grey on Setup.

- **Edits are a working copy until you save.** Opening a scene and editing it changes a copy kept in the browser only; the stored scene changes when you press **Save** (or **Save as new…**, which leaves the original alone). **Revert** throws the edits away. *Unsaved* in the top bar (and a note on Control's scene list) shows there's something to save; opening another scene or New asks first (Save / Save as new / Discard / Cancel), and so does closing the tab. The working copy stays while you visit the other pages.
- **Blind and Live, like a lighting console.** In Blind nothing goes to the server while you edit; hold **Hold to see the porch** (or the Space bar, with the Move tool picked) to see what's on stage instead. **Go** puts the stored scene on stage (with unsaved edits it asks: Save and Go, or Go with the stored version). In Live the porch shows your edits as you make them, without storing them (`POST /api/stage/preview`); Save stores them, Revert puts the stored version back. Playlists, the schedule and Home Assistant only ever play stored scenes. The 3D view uses the server's clock, so it animates in step with the real lights.
- **Brush and Eraser** turn the 3D view into a canvas: pick a colour or an effect (or a saved preset), then drag over the lights. An effect paints as a pattern, not a colour: it's a mask (white on black) over what's below, so the lights you've already coloured twinkle, chase or ripple in their own colours. Only the effects that make a pattern that way are offered (`packages/web/test/pattern-effects.test.ts` checks each one). Size, soft edge and strength are on the brush; the Eraser (or holding Option/Alt) wipes paint off; each stroke is one Undo step. The Brush starts a new, blank scene (every light off); **Save as new…** stores it under a name. What you paint becomes painted layers of that scene, so it follows Blind and Live like any other edit.
- **Streaming** hands the porch between this server and its WLED playlist. **Brightness** is the master level on the porch. Both are in the top bar on Control and Setup, and in ⋯ on Create.

## Public demo

`https://demoxmas.weiss-audio.com` is a demo of the app that anyone can open without signing in. It has Control and Create (no Setup), all the scenes and playlists, and extra strings that exist only in the demo: spirals round the mailbox post and box, along the handrail of the cement stairs, strings zig-zagging up and down the four front bushes, and a coil up the big tree's trunk to where the branches start (`config/demo-extras.json`, placed from the house scan). Visitors can Go, play playlists, change brightness and edit in Blind or Live, but nothing is stored: every Save, rename and delete is off, and a ribbon at the top says so.

- **Nothing reaches the lights.** The demo runs in the visitor's browser: the demo build of the UI (`npm run build:web:demo`, into `packages/web/dist-demo`) answers the app's requests itself (`packages/web/src/demo/backend.ts`), so each visitor's Go and Live edits stay in their own tab.
- **The demo server only serves files** (`packages/server/src/demo.ts`): the demo build, `/demo/show.json` and the house model. It answers GET and HEAD only. `/demo/show.json` is built from `data/show.json` whenever that changes, so new scenes appear in the demo without a deploy. It's an allow-list: the schedule (with the home's coordinates), controller addresses, Home Assistant, backups and mapping are left out.
- **Docker:** the `xmas-demo` service in `docker-compose.yml`, on `127.0.0.1:8091` (`XMAS_DEMO_PORT`), bridge networking, `./data` mounted read-only, a read-only root filesystem and no secrets. Cloudflare's tunnel sends `demoxmas.weiss-audio.com` to it, with no Access in front.
- **Check it in a browser:** `npm run build:web:demo && node scripts/e2e-demo.mjs [data folder]`.

## Concepts

- **Controller**: one WLED box. Pixels are numbered globally, controller by controller, in config order.
- **Run**: a contiguous block of pixels on one controller, placed along a polyline in metres (or measured `positions` from camera mapping later).
- **Group**: a named set of runs and pixels. Every run is also the group `run:<id>`, and `all` always exists.
- **Scene**: a stack of layers. Each layer is an effect plus params, an optional group mask, opacity and blend (`normal`, `add`, `multiply`, `screen`, `max`). A layer may also carry `paint`: how strongly it shows on each light (base64, one byte per global pixel, trailing zeros dropped). A painted layer shows only where it was painted.
- **Effects** (`GET /api/effects` lists them with param specs): the app's own `solid`, `rainbow`, `sweep`, `twinkle`, `noise` (Aurora), `stripes` (Candy cane) and `ripple`, which work in normalised 3D space so a sweep crosses the whole house however the strings are wired; plus 175 effects ported from WLED (see `packages/engine/src/wled/PORTING.md`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/status` | Active scene, `stage {scene, dirty}`, output settings, real fps, render time, per-controller health, `homeassistant {enabled, connected}` |
| GET | `/api/stage` | The scene the porch is running now (can differ from the saved copy while Blind edits are pending, or during a Live preview) |
| POST/DELETE | `/api/stage/preview` | Live editing: POST a scene body (`{ name, layers }`, validated like a save) to show it on the porch without storing it; `stage.preview` in `/api/status` names it. Never saved: a restart, Go, Blackout, a playlist or the schedule puts a stored scene back. Posting a scene's stored version ends the preview; DELETE puts back what was on stage before |
| GET | `/api/clock` | Effect time in seconds, so the browser preview renders the same frame as the porch |
| GET | `/api/effects` | Effect catalogue with param specs |
| GET/PUT | `/api/layout` | Read or replace the layout (validated; the active scene is dropped if it no longer fits) |
| GET | `/api/groups` | Group names and pixel counts |
| GET | `/api/scenes` | All scenes plus the active one |
| GET/PUT/DELETE | `/api/scenes/:name` | PUT validates and fills in defaults. A Live save (default) updates the porch if the scene is on stage; `?apply=false` is a Blind save that leaves the porch alone |
| POST | `/api/scenes/:name/activate` | Go: put the saved scene on stage |
| POST | `/api/scenes/:name/rename` | `{ to }`: rename a scene; playlists, the schedule and the stage follow it |
| POST | `/api/login` | `{ token }`: sign the web UI in (sets a cookie) when `XMAS_API_TOKEN` is set |
| POST | `/api/blackout` | All pixels off (streaming continues) |
| GET/PATCH | `/api/output` | `{ enabled, brightness, gamma, fps }`. `enabled:false` stops streaming and loads fallback presets |
| GET | `/api/frame` | Current frame, raw RGB bytes in global pixel order (as sent: Identify and mapping included) |
| GET | `/api/mapping` | Camera mapping: whether a sequence is playing, its start and end on the `/api/clock` clock |
| POST | `/api/mapping/start` | `{ k, passes, holdMs, level, leadMs }`: play the coded sequence (dark for `leadMs`, then about 13 s); returns the plan and `startsAt`. Visible only while streaming |
| POST | `/api/mapping/stop` | Stop the sequence; the show comes straight back |
| GET/POST/DELETE | `/api/mapping/views[/:id]` | What the phone found from each spot (pixel → picture position), kept for solving again |
| POST | `/api/backups` | `{ reason }`: save a backup now (`<reason>-<time>.json`, last 10 kept) |
| GET | `/api/controllers` | Health: online, WLED version, LED-count mismatch warnings, frames sent |
| POST | `/api/controllers/discover?timeout=3000` | mDNS scan for `_wled._tcp`, enriched with `/json/info` |
| POST | `/api/controllers/probe` | `{ host }`: check that an IP is a WLED controller |
| GET | `/api/controllers/:id/presets` | The controller's WLED presets |
| POST | `/api/controllers/:id/preset` | `{ preset }`: load a WLED preset on that controller |
