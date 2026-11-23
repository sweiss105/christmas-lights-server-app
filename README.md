# xmas-lights

Spatial Christmas light controller for xmas.weiss-audio.com. It renders effects in 3D space across about 2900 pixels and streams them over DDP to two GLEDOPTO GL-C-618WL (WLED) controllers.

**Status:** Phase 1 (engine, DDP, discovery, REST API) is done. See [docs/PLAN.md](docs/PLAN.md).

## Layout

```
packages/engine   Effects, layout model and layer compositor. Pure TypeScript, so the server and browser preview share it.
packages/server   40 fps output loop, DDP sender, WLED client and mDNS discovery, REST API (Fastify)
config/example.json   Sample layout (2 controllers × 1450 px), scenes and output settings
```

## Run

```sh
npm install
npm test               # 25 tests, including DDP end-to-end against a fake WLED receiver
npm start              # http://localhost:8080; state is saved to config/local.json
```

On the home server use `docker compose up -d --build`. It needs host networking, because mDNS and DDP must reach the LAN. State lives in `./data/show.json`. Host networking shares the host's ports, so if 8080 is taken, set `XMAS_PORT` (for example `XMAS_PORT=8090`) in `.env`.

Environment variables:

| Var | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `XMAS_CONFIG` | `config/local.json` | State file; on first run it starts from `config/example.json` |
| `XMAS_API_TOKEN` | unset | Requires `Authorization: Bearer <token>` on every `/api` route except `/api/health`. **Set this or put Cloudflare Access in front before you expose the site through cloudflared.** |

## WLED setup (each controller)

1. Set the LED count under *Settings → LED Preferences* to match `pixelCount` in the layout.
2. Leave *Settings → Sync Interfaces → Realtime → Receive UDP realtime* on. DDP listens on UDP 4048.
3. Save a preset (for example ID 1, warm white) and set it as `fallbackPreset`. The server loads it when streaming stops or the server shuts down cleanly. If the server dies, WLED leaves realtime mode by itself after its timeout (2.5 s by default).
4. If WLED is gamma-correcting realtime data, set `gamma` to 1 via `PATCH /api/output` so it isn't applied twice.

## Concepts

- **Controller**: one WLED box. Pixels are numbered globally, controller by controller, in config order.
- **Run**: a contiguous block of pixels on one controller, placed along a polyline in metres (or measured `positions` from camera mapping later).
- **Group**: a named set of runs and pixels. Every run is also the group `run:<id>`, and `all` always exists.
- **Scene**: a stack of layers. Each layer is an effect plus params, an optional group mask, opacity and blend (`normal`, `add`, `multiply`, `screen`, `max`).
- **Effects** (`GET /api/effects` lists them with param specs): `solid`, `rainbow`, `sweep`, `twinkle`, `noise` (Aurora), `stripes` (Candy cane), `ripple`. They work in normalised 3D space, so a sweep crosses the whole house however the strings are wired.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/status` | Active scene, output settings, real fps, render time, per-controller health |
| GET | `/api/effects` | Effect catalogue with param specs |
| GET/PUT | `/api/layout` | Read or replace the layout (validated; the active scene is dropped if it no longer fits) |
| GET | `/api/groups` | Group names and pixel counts |
| GET | `/api/scenes` | All scenes plus the active one |
| GET/PUT/DELETE | `/api/scenes/:name` | PUT validates, fills in defaults and live-updates if the scene is active |
| POST | `/api/scenes/:name/activate` | Switch scene |
| POST | `/api/blackout` | All pixels off (streaming continues) |
| GET/PATCH | `/api/output` | `{ enabled, brightness, gamma, fps }`. `enabled:false` stops streaming and loads fallback presets |
| GET | `/api/frame` | Current frame, raw RGB bytes in global pixel order |
| GET | `/api/controllers` | Health: online, WLED version, LED-count mismatch warnings, frames sent |
| POST | `/api/controllers/discover?timeout=3000` | mDNS scan for `_wled._tcp`, enriched with `/json/info` |
| POST | `/api/controllers/probe` | `{ host }`: check that an IP is a WLED controller |
| GET | `/api/controllers/:id/presets` | The controller's WLED presets |
| POST | `/api/controllers/:id/preset` | `{ preset }`: load a WLED preset on that controller |
