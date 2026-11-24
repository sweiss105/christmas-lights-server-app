# Handoff: Phase 1 → test on real hardware

Written 2026-11-23 from the cloud session that built Phase 1. Pick up from here on the home server, which can reach the LAN, the WLED controllers and Docker.

## Where things stand

- Branch `phase-1-engine-ddp-api` has all of Phase 1 in one commit (`e8563da`) plus this note. No pull request yet.
- Built: the TypeScript effect engine (`packages/engine`), the server (`packages/server`) with DDP output at 40 fps, the WLED client with mDNS discovery and health checks, the REST API, JSON state persistence, and Docker/compose files. See `README.md` for the API and `docs/PLAN.md` for phases and deadlines.
- Verified in the cloud: `npm test` passes 25/25 (12 runs in a row) and `tsc -b` is clean. A real server run streamed at 40 fps with a 1.1 ms render, and Ctrl-C handed the controllers back to their fallback presets.
- **Never tested:** real WLED controllers (no LAN access) and the Docker image (no Docker daemon in the cloud).

**Deadline:** lights on the house by **Dec 5**. That means Phase 1 on real hardware plus a layout good enough to run scenes. The full editor (Phases 2–5) is due by Christmas.

## Steps, in order

1. **Get the code and run the tests**
   ```sh
   git fetch origin phase-1-engine-ddp-api && git checkout phase-1-engine-ddp-api
   npm ci && npm test && npx tsc -b
   ```
   Expect 25 passing. Tests import the engine from TypeScript source through the `source` export condition (`vitest.config.ts`), so no build step is needed.

2. **Find the controllers.** Both are GLEDOPTO GL-C-618WL running WLED.
   ```sh
   npm start   # :8080; first run copies config/example.json → config/local.json
   curl -X POST 'localhost:8080/api/controllers/discover?timeout=4000'
   curl -X POST localhost:8080/api/controllers/probe -H 'content-type: application/json' -d '{"host":"<ip>"}'
   ```
   If mDNS finds nothing, check that the server and controllers share a subnet or VLAN with UDP 5353 allowed, then fall back to probing the IPs directly.

3. **Put the real details into the layout.** `config/example.json` is a placeholder house.
   - Set each controller's `host`. The IPs `192.168.1.50` and `.51` are placeholders.
   - Set each `pixelCount` to match WLED's LED count. Last session's assumption was 1450 + 1450 = 2900; confirm it.
   - Set each `fallbackPreset` to a preset ID that exists on that controller (`GET /api/controllers/:id/presets`).
   - Replace the `runs` with the real strings: which controller, start index, count, and a rough polyline in metres along each roofline, eave, window or tree. Rough is fine; camera mapping (Phase 3) refines it later.
   - Apply with `PUT /api/layout`, or edit `config/local.json` while the server is stopped.
   - Ask the owner for string order, counts and rough measurements. Don't guess them.

4. **WLED settings on each controller** (README has details): realtime UDP receive on (DDP is UDP 4048), LED count matches, and a fallback preset saved. If WLED gamma-corrects realtime data, `PATCH /api/output {"gamma":1}`.

5. **Light test.** Start at low brightness.
   ```sh
   curl -X PATCH localhost:8080/api/output -H 'content-type: application/json' -d '{"brightness":0.3,"enabled":true}'
   curl -X POST "localhost:8080/api/scenes/Warm%20white/activate"
   curl localhost:8080/api/status   # fps ≈ 40, sendErrors 0, controllers online, no LED-count warning
   ```
   - Then try `Candy cane` and `Aurora`, and check that the sweep and stripes cross the house in the right direction. If a string runs backwards, reverse that run's polyline points.
   - Watch for stutter over Wi-Fi. If it appears, try `{"fps":30}`.
   - Finally, `{"enabled":false}` should put each controller on its fallback preset within a second.

6. **Docker.** This is the first build of the image anywhere.
   ```sh
   docker compose up -d --build && docker compose logs -f
   ```
   - It uses host networking, which mDNS and DDP need, and keeps state in `./data/show.json`.
   - Copy the working `config/local.json` to `data/show.json` first.
   - `docker compose stop` should trigger the fallback presets (10 s grace period).

7. **Before exposing xmas.weiss-audio.com through cloudflared:** set `XMAS_API_TOKEN` in `.env` and/or put Cloudflare Access in front. Without one, the API is open to anyone who can reach it.

## Hardware test results (2026-11-24, home server)

Steps 1–6 pass on the real porch controller.

- **Hardware differs from the plan.** Only one controller is running for now: GLEDOPTO WLED 0.15.3 at `10.30.1.40`, 1101 LEDs. The second controller isn't running yet. Of its outputs, GPIO16 (pixels 0–499) wraps the left porch railing and goes down the left stair rail. GPIO12 (500–999) goes up the right stair rail, along the right railing, down the end post and back along the bottom runner. Each is about 6.5 m. GPIO4 (100 px) and GPIO2 (1 px) have nothing connected and aren't in the layout. The fallback is playlist 26.
- **The layout is rough** (owner: "close enough for now"). It's in `config/local.json` and `data/show.json`, neither of which is in git. Directions are verified: stripes and sweep move left to right on both runs, so no run needed reversing.
- **Streaming:** 40 fps held steady over Wi-Fi at −73 to −80 dBm with 0 send errors and no dropped frames, both from `npm start` and from the container. WLED's gamma correction is off for realtime data, so the server keeps gamma 2.2.
- **Hand-back:** turning streaming off and running `docker compose stop` both put the controller back on its fallback, in under 0.5 s.
- **Docker:** the image builds, and the stop signal reaches the server through `npm` → `tsx` → `node`, with a clean exit 0. On the home server, port 8080 is taken by another service, so `.env` sets `XMAS_PORT=8090`. The compose file now reads `XMAS_PORT`.
- **Watch for:** `output.enabled` is saved, so a restart resumes streaming if it was on. The container runs as root, so `data/show.json` becomes root-owned once the container saves it. Node on the home server is a per-user install in `~/.local/node`.

## Phase 2 progress (2026-11-24, branch `phase-2-web-ui`)

**Live:** xmas.weiss-audio.com (Cloudflare Access, owner only) serves the web UI from the container on port 8090. It's deployed from clean checkouts of committed code, and only while the owner isn't using the site.

**Done and deployed:**
- **M1:** 3D preview running the shared engine, in step with the server clock. Scenes list with Blind preview and Go, brightness, streaming switch, blackout, health.
- **M2:** scene editor. Layers, effect settings generated from param specs, Blind/Live with a LIVE indicator, undo/redo, and new/duplicate/rename/delete scenes.
- **Presets:** saved layer looks, `/api/presets`. A categorised, searchable layer picker.
- **House model:** upload a `.glb` scan and align it with the lights (`/api/house`). The owner scans the house with an iPhone 17 Pro Max (Scaniverse); a stand-in model was used for testing.
- **Layout editor:** runs, points, drag handles, draw on the house, reverse, save, and **Identify** (`/api/identify`, flashes a run while streaming).
- **Crossfade on Go and Blackout** (`output.transition`, default 1 s).
- **Palette picker** with gradients.

**WLED effects: done.** 175 effects ported from WLED v16.0.1, the controller's firmware: 126 1D, 53 2D (drawn over the house front) and 23 particle effects, plus Scrolling Text with WLED's fonts.
- The project is EUPL-1.2 as a result (`LICENSE`, `NOTICE`).
- The compatibility layer is in `packages/engine/src/wled/`; read `PORTING.md` there.
- Excluded: the 37 microphone effects (owner's choice), Copy Segment (no segments here) and Image (needs an upload feature).
- New WLED layers start on the Party palette when the effect names none (owner's choice).

**Also done:**
- Mask and inverted-mask blend modes, plus clipping masks (`maskScope: 'layer'`).
- The staged scene survives restarts (`state.stage`).
- A phone layout with a bottom sheet.
- `XMAS_TZ` sets the time zone for `#TIME`; it's UTC until the owner gives a zone.

**Still open:**
- The PR for Phase 2: the owner wants it once the house scan is in.
- Engine tests fail to load while effect files are half-written. Verify agent work in a clean worktree (`git worktree add` + `npm ci`) before committing.

## Known gaps and things to watch

- **Health-check timing:** they run every 10 s via HTTP to `/json/info`, so a controller that was offline at startup shows `online:false` until the next check.
- **Rendering when streaming is off:** `GET /api/frame` renders on demand, so it works even with streaming off.
- **Wi-Fi load:** about 8 UDP packets per frame (2 controllers × 4), roughly 350 KB/s at 40 fps.
- **Firewall:** the server needs outbound UDP 4048, UDP 5353 (mDNS) and TCP 80 to the controllers.

## After the hardware works

- Fix anything found above, then open a PR from `phase-1-engine-ddp-api` into `main`. Ask the owner first.
- **Phase 2** (see `docs/PLAN.md`): web UI with a 3D preview that runs `@xmas/engine` in the browser, a manual line tool for placing runs, and scene and layer editing. Load the apple-design skill before starting UI work; the owner asked for that.
