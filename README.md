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
npm run dev:web        # UI dev server on :5173 with hot reload, proxying /api to XMAS_API (default http://127.0.0.1:8090)
```

On the home server use `docker compose up -d --build`. It needs host networking, because mDNS and DDP must reach the LAN. State lives in `./data/show.json`. Host networking shares the host's ports, so if 8080 is taken, set `XMAS_PORT` (for example `XMAS_PORT=8090`) in `.env`.

Environment variables:

| Var | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `XMAS_CONFIG` | `config/local.json` | State file; on first run it starts from `config/example.json` |
| `XMAS_WEB_ROOT` | `packages/web/dist` | Built web UI served at `/` |
| `XMAS_TZ` (Docker) / `TZ` | UTC | Time zone for Scrolling Text's `#TIME`/`#DATE` tokens, e.g. `America/Chicago` |
| `XMAS_API_TOKEN` | unset | Requires `Authorization: Bearer <token>` on every `/api` route except `/api/health`. **Set this or put Cloudflare Access in front before you expose the site through cloudflared.** |

## WLED setup (each controller)

1. Set the LED count under *Settings → LED Preferences* to match `pixelCount` in the layout.
2. Leave *Settings → Sync Interfaces → Realtime → Receive UDP realtime* on. DDP listens on UDP 4048.
3. Save a preset (for example ID 1, warm white) and set it as `fallbackPreset`. The server loads it when streaming stops or the server shuts down cleanly. If the server dies, WLED leaves realtime mode by itself after its timeout (2.5 s by default).
4. If WLED is gamma-correcting realtime data, set `gamma` to 1 via `PATCH /api/output` so it isn't applied twice.

## Web UI

Open the server's address in a browser (xmas.weiss-audio.com behind Cloudflare Access, or `http://<server>:8090` at home). It's built for desktop and tablet.

- **Blind and Live, like a lighting console.** Picking a scene previews it in 3D without touching the porch. **Go** puts it on stage. Blind edits (`?apply=false`) are saved but stay off the porch until Go; the status pill shows *edited, not sent*.
- **Preview / Stage** switches the 3D view between what you're working on and what the porch is running. The preview uses the server's clock, so it animates in step with the real lights.
- **Streaming** hands the porch between this server and its WLED playlist. **Brightness** is the master level on the porch.

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
| GET | `/api/status` | Active scene, `stage {scene, dirty}`, output settings, real fps, render time, per-controller health |
| GET | `/api/stage` | The scene the porch is running now (can differ from the saved copy while Blind edits are pending) |
| GET | `/api/clock` | Effect time in seconds, so the browser preview renders the same frame as the porch |
| GET | `/api/effects` | Effect catalogue with param specs |
| GET/PUT | `/api/layout` | Read or replace the layout (validated; the active scene is dropped if it no longer fits) |
| GET | `/api/groups` | Group names and pixel counts |
| GET | `/api/scenes` | All scenes plus the active one |
| GET/PUT/DELETE | `/api/scenes/:name` | PUT validates and fills in defaults. A Live save (default) updates the porch if the scene is on stage; `?apply=false` is a Blind save that leaves the porch alone |
| POST | `/api/scenes/:name/activate` | Go: put the saved scene on stage |
| POST | `/api/blackout` | All pixels off (streaming continues) |
| GET/PATCH | `/api/output` | `{ enabled, brightness, gamma, fps }`. `enabled:false` stops streaming and loads fallback presets |
| GET | `/api/frame` | Current frame, raw RGB bytes in global pixel order |
| GET | `/api/controllers` | Health: online, WLED version, LED-count mismatch warnings, frames sent |
| POST | `/api/controllers/discover?timeout=3000` | mDNS scan for `_wled._tcp`, enriched with `/json/info` |
| POST | `/api/controllers/probe` | `{ host }`: check that an IP is a WLED controller |
| GET | `/api/controllers/:id/presets` | The controller's WLED presets |
| POST | `/api/controllers/:id/preset` | `{ preset }`: load a WLED preset on that controller |
