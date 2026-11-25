# xmas-lights

Spatial Christmas light controller for xmas.weiss-audio.com. It renders effects in 3D space across about 2900 pixels and streams them over DDP to two GLEDOPTO GL-C-618WL (WLED) controllers.

**Status:** Phase 1 (engine, DDP, discovery, REST API) is done and running on the porch. Phase 2 (web UI) is in progress: see [docs/PHASE2-PLAN.md](docs/PHASE2-PLAN.md) and [docs/PLAN.md](docs/PLAN.md).

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
| **Porch Lights** (light) | Off = Blackout: the porch goes dark but stays under the app's control. On = puts back the last scene that was on (or the first scene). Brightness is the app's master brightness. |
| **Scene** (select) | Lists the scenes as the app does. Choosing one is the app's Go (with its fade), and stops a playing playlist. Shows the scene on the porch, or nothing when blacked out. |
| **Playlist** (select) | `(none)` plus your playlists. Choosing one plays it; `(none)` stops it (the scene on stage stays on). |
| **App controls porch** (switch) | The app's streaming switch. On: the app drives the porch. Off: the porch is handed back to the WLED controller's own playlist. |
| **Now showing** (sensor) | The scene on the porch, `Off` when blacked out, or `WLED playlist` when the app isn't controlling the porch. |
| **Controller** (connectivity, diagnostic) | Whether the WLED controller answers the app's health checks. |

**Streaming must be on** (*App controls porch*) for the porch to follow the light, scene and playlist controls. With it off they still change what the app has on stage, which shows as soon as streaming is turned back on, e.g. by the nightly schedule.

Scenes and playlists added, renamed or deleted in the app show up in the selects straight away. Everything goes through the same code as the app's own buttons, so fades, playlists, the schedule and saving work the same either way. Home Assistant shows the device as unavailable when the app is stopped or can't be reached.

## WLED setup (each controller)

1. Set the LED count under *Settings → LED Preferences* to match `pixelCount` in the layout.
2. Leave *Settings → Sync Interfaces → Realtime → Receive UDP realtime* on. DDP listens on UDP 4048.
3. Save a preset (for example ID 1, warm white) and set it as `fallbackPreset`. The server loads it when streaming stops or the server shuts down cleanly. If the server dies, WLED leaves realtime mode by itself after its timeout (2.5 s by default).
4. If WLED is gamma-correcting realtime data, set `gamma` to 1 via `PATCH /api/output` so it isn't applied twice.

## Web UI

Open the server's address in a browser (xmas.weiss-audio.com behind Cloudflare Access, or `http://<server>:8090` at home). It's built for desktop and tablet.

- **Blind and Live, like a lighting console.** Picking a scene previews it in 3D without touching the porch. **Go** puts it on stage. Blind edits (`?apply=false`) are saved but stay off the porch until Go; the status pill shows *edited, not sent*.
- **Preview / Stage** switches the 3D view between what you're working on and what the porch is running. The preview uses the server's clock, so it animates in step with the real lights.
- **Paint** turns the 3D view into a canvas: pick a colour or an effect (or a saved preset), then drag a brush over the lights. Size, soft edge and strength are on the brush; Erase (or holding Option/Alt) wipes paint off; each stroke is one Undo step. What you paint is saved in the scene as painted layers, so it follows Blind and Live like any other edit: with Live armed on the scene that's on stage, each stroke shows on the porch as you draw.
- **Streaming** hands the porch between this server and its WLED playlist. **Brightness** is the master level on the porch.

## Concepts

- **Controller**: one WLED box. Pixels are numbered globally, controller by controller, in config order.
- **Run**: a contiguous block of pixels on one controller, placed along a polyline in metres (or measured `positions` from camera mapping later).
- **Group**: a named set of runs and pixels. Every run is also the group `run:<id>`, and `all` always exists.
- **Scene**: a stack of layers. Each layer is an effect plus params, an optional group mask, opacity and blend (`normal`, `add`, `multiply`, `screen`, `max`). A layer may also carry `paint`: how strongly it shows on each light (base64, one byte per global pixel, trailing zeros dropped). A painted layer shows only where it was painted.
- **Effects** (`GET /api/effects` lists them with param specs): `solid`, `rainbow`, `sweep`, `twinkle`, `noise` (Aurora), `stripes` (Candy cane), `ripple`. They work in normalised 3D space, so a sweep crosses the whole house however the strings are wired.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/status` | Active scene, `stage {scene, dirty}`, output settings, real fps, render time, per-controller health, `homeassistant {enabled, connected}` |
| GET | `/api/stage` | The scene the porch is running now (can differ from the saved copy while Blind edits are pending) |
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
