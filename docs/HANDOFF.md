# Handoff

Updated 2026-11-25, after PR #11 (Home Assistant). Read this first; it replaces the older Phase 1 and Phase 2 notes that used to be here. Plans and history: `docs/PLAN.md` (phases and deadlines), `docs/PHASE2-PLAN.md` (the web UI plan, now built), `README.md` (setup, API, Home Assistant).

**Deadlines:** lights on the house by **Dec 5** (met: the porch has been running from the app since 2026-11-24). The full editor by **Christmas**.

## At a glance

- **Live site:** xmas.weiss-audio.com, behind Cloudflare Access (owner only). Cloudflare tunnel → the container on the home server, `http://127.0.0.1:8090`.
- **Home server:** 10.10.1.26. The app runs in Docker with host networking on **port 8090** (8080 is taken by another service; `.env` sets `XMAS_PORT=8090`). State is in `data/show.json` in the main checkout, plus `data/backups/`, `data/mapping-views.json`, `data/mapping-recordings/` and the house model `.glb`. None of `data/` is in git, and the container makes its files root-owned.
- **Hardware:** one controller so far, a GLEDOPTO GL-C-618WL at **10.30.1.40** running WLED 16.0.1, 1101 LEDs, controller id `porch`. Its fallback (what WLED plays when the app lets go) is playlist **26**, "Warm & Cool Playlist". The second controller isn't running yet.
- **Home Assistant:** 10.10.1.25, linked over MQTT (see [Home Assistant](#home-assistant)).
- **Tests:** about 530 unit tests (`npm test`), `npm run typecheck`, `npm run build:web`, and a browser smoke test (`npm run e2e`). GitHub Actions runs typecheck, tests and the web build on every push to `main` and every PR (`.github/workflows/ci.yml`).
- **Licence:** EUPL-1.2, because WLED's effect code is ported (`LICENSE`, `NOTICE`).

## What's built and live

Everything below is merged to `main` and deployed.

| Area | What it does | Code |
|---|---|---|
| Engine | Effects, layout model (runs, coils, groups, measured positions), layer compositor with blend modes, masks and paint. Shared by the server and the browser preview. | `packages/engine/src/` (`effects.ts`, `layout.ts`, `scene.ts`, `paint.ts`, `fx/`) |
| WLED effects | 175 effects ported from WLED 16.0.1 (126 1D, 53 2D, 23 particle, minus Copy Segment and Image), Scrolling Text with WLED's fonts, WLED's 72 palettes. 1D effects have a **Lights run** setting (along each string, one long strip, across, up, out from the centre). | `packages/engine/src/wled/` (read `PORTING.md` there) |
| Output | 40 fps DDP to the controllers, crossfade on Go and Blackout, gamma 2.2 (WLED doesn't gamma-correct realtime data), hand-back to the WLED fallback when streaming stops. | `packages/server/src/output.ts`, `ddp.ts`, `wled.ts` |
| REST API and state | Fastify routes, JSON state with change counter, token sign-in (`XMAS_API_TOKEN`), startup recovery from the newest good backup if `show.json` is damaged. | `packages/server/src/api.ts`, `store.ts`, `main.ts` |
| Web UI | 3D preview in step with the server clock; scenes with Blind / Go / Live; scene and layer editor with undo; layer presets; palette picker with editable colours and saved palettes; Select tools and groups; Layout editor with Identify; House panel; phone layout with a bottom sheet. | `packages/web/src/` |
| House model | The owner's clean model built from the Polycam scans (metres, Y up, +Z to the street, named parts such as `railings`, `handrail`, `cement_stairs`). Uploaded as one part, "House" (`data/house-part2.glb`). Untextured models get a lit clay look; the lights cast a coloured glow onto it (`house.glow`, preview only). Copies of the source files are in `~/scans/` on the server. | `HouseModel.tsx`, `HousePanel.tsx`, `glow.ts`, `glowMaterial.ts` |
| Show automation | Playlists (loop, **shuffle**), a nightly schedule (sunset or a fixed time, in a time zone), daily backups (14 kept) and manual backups (10 of each kind kept). | `packages/server/src/show.ts`, `api.ts` |
| Paint mode | Brush colours or effects onto the lights in the 3D view; strokes become painted layers of the scene. | `packages/engine/src/paint.ts`, `packages/web/src/paint.ts`, `PaintPanel.tsx`, `PaintOverlay.tsx` |
| Camera mapping | Coded flash sequence, decoding on the iPhone in the browser, camera solving and triangulation, review and save; footage recording, camera controls, brightness test. Not yet producing usable positions on real lights (see below). | `packages/server/src/mapping.ts`, `packages/engine/src/mapping/`, `packages/web/src/mapping/` |
| Home Assistant | MQTT discovery device "Porch Lights". | `packages/server/src/homeassistant.ts` |

### Merged pull requests

| PR | What |
|---|---|
| #1 | Phase 1: engine, DDP, WLED discovery, REST API, Docker |
| #2 | Phase 2: web UI, WLED effects, show automation, house model, select tools, coiled runs |
| #3 | The lights cast a glow onto the house model (merged through #4) |
| #4 | Phase 3: camera mapping on the phone |
| #5 | First audit fixes: saves, schedule restarts, scene renames, sign-in, UI crashes |
| #6 | Paint mode |
| #7 | Mapping: footage recording, camera controls, brightness test, solver for close spots |
| #8 | WLED colour slots kept for "* Color" palettes; shuffled playlists |
| #9 | Editable palette colours, saved palettes; a missing house model no longer crashes the app |
| #10 | Second audit fixes: shuffle overflow, measured runs in Layout, mapping saves, startup recovery, CI |
| #11 | Home Assistant over MQTT discovery |

## What the real hardware taught us

### The porch strings (layout in `data/show.json`)

- Two runs on the one controller, both **coiled** round the railings of the house model (`coil: { radius 0.045, pitch 0.27 }`, one turn per baluster gap):
  - **`porch-left`**, pixels 0–499 (GPIO16): starts on the left side rail 0.5 m from the house, then the front and down the left stair rail.
  - **`porch-right`**, pixels 500–999 (GPIO12): up the right stair rail, along the front and the right side to the house, straight down the post (`skip`), then back along the bottom rails.
  - GPIO4 (100 px) and GPIO2 (1 px) have nothing connected, so pixels 1000–1100 aren't in any run.
- The group `porch` holds both runs. Directions are verified: sweeps and stripes move left to right.
- 40 fps holds over Wi-Fi at −73 to −80 dBm with no send errors. Turning streaming off, or stopping the container, hands the porch back to playlist 26 in under half a second.
- `output.enabled` is saved, so a restart resumes streaming if it was on.

### The first mapping night (2026-11-24)

Four spots were filmed on the iPhone 17 Pro Max. All four decoded lights, but placing the camera failed at first. PR #7 added recording and a better solver; replayed against the footage, 3 of the 4 spots now solve.

- **iPhone Safari camera limits:** only **white balance** can be locked. Exposure and focus can't. Video stays at **30 fps at 1080p**, whatever is asked for. The 0.5× view isn't a separate camera: it's available as **zoom** on the "Back Triple Camera" (the "wide zoom" setting).
- **Footage** of each spot is kept on the server in `data/mapping-recordings/` (greyscale, 640 px wide, gzip; newest 6 kept). Spots 1, 3 and 4 are there now. The spots' detections are in `data/mapping-views.json`.
- **Why only 3 of 4 solved:** the spots were 1–3 m from the lights. From that close the porch lights are too nearly flat (they lie almost in one plane) to fix the camera reliably.
- **The model doesn't match the real lights in two places:** the start of the left string (lights **0–90**) and the bottom runner (about **670–820**). The owner has decided to keep the model-based layout for now anyway (see [Owner decisions](#owner-decisions)).
- **Next night test:** film from **3–5 m out**, so the rails are seen in depth: the top of the front walk, the lawn front-left, the lawn front-right, and a tripod raised over the hedge.

## WLED import (2026-11-25)

The owner's WLED presets and playlists were brought into the app through the API (a one-off; there's no import script in the repo).

- **52 presets became scenes.** Each runs on group `porch` with the Lights run setting "One long strip", like a WLED segment. The preset's brightness became the layer's opacity.
- **3 playlists:** Candy cane playlist, Christmas colors playlist, and Warm & Cool Playlist. **Shuffle** is on for Candy cane and Christmas colors.
- **5 sound-reactive presets were skipped** (no microphone effects here): Christmas matrix, Christmas glow up, Christmas ripple Peak, Party mode, and Warm, cool matrix pics.
- The app now has 53 scenes: the 52 imported plus one other, "Candy Cane Lane".
- WLED itself still has its presets and playlist 26 as the fallback; nothing on the controller was changed.

## Home Assistant

- The app connects to Home Assistant's **Mosquitto add-on at 10.10.1.25:1883** as MQTT user **`xmas`**. The URL, user and password are only in the server's `.env` (chmod 600). Never read, print or commit the password.
- It appears as the device **Porch Lights** with these entities (details in `README.md`, "Home Assistant"):
  - **Porch Lights** (light): off = blackout (the app keeps control); on = **turns streaming on** and puts back the last scene; brightness = master brightness.
  - **Scene** and **Playlist** (selects): same as Go and Play in the app.
  - **App controls porch** (switch): the streaming switch; off hands the porch to WLED's playlist 26.
  - **Now showing** (sensor) and **Controller** (connectivity, diagnostic).
- `/api/status` reports `homeassistant: { enabled, connected }`; the health bar shows "Home Assistant linked". A broker that's down never affects the lights.

## Owner decisions

- **Blind / Live / Go**, like a lighting console. Desktop and tablet first; a phone layout exists too. Load the apple-design skill before UI work.
- **Port WLED's own code** for effects and palettes, so the project is EUPL-1.2. **No microphone effects.**
- New WLED layers start on the Party palette when the effect names none.
- **Saved palettes are copies, not links:** a layer keeps its own colours, so renaming or deleting a saved palette never changes a scene.
- **Turning the Home Assistant light on also turns streaming on.**
- **Camera mapping runs on the iPhone in the web app**, not with Marimapper.
- **Keep the current model-based coiled porch layout** (2026-11-25). No porch check of the coil, the bottom runner or the left-string start is planned; the layout will be redone later from better scans or mapping.
- **The 5 sound-reactive WLED presets stay out**; don't recreate them with substitutes (2026-11-25).
- **Schedule:** time zone America/Chicago, latitude 43.01, longitude −88.23 (rounded). It's configured to turn on at sunset, off at 23:00, running the Christmas colors playlist, but it's **left disabled**, since Home Assistant may do the timing. `XMAS_TZ=America/Chicago` is in `.env` and takes effect at the next deploy (it sets the zone for Scrolling Text's `#TIME`).
- Deploying is allowed at any time, but check first that the owner isn't using it (below). Ask before any other WLED change: settings, presets, or streaming the porch during tests.

## How to work on this repo

### Worktrees

- Another Claude session may be working in the main checkout (`/home/weissaudio/christmas-lights-server-app`) at the same time. Don't switch its branch. Do each task in its own worktree: `git worktree add <path> -b <branch> origin/main`.
- Run `npm ci` in the worktree itself. **Never run `npm ci` through a symlinked `node_modules`**: it deletes the target's contents, breaking the other checkout.
- Node 22 is a per-user install: put `~/.local/node/bin` on `PATH`.
- Git has no identity configured: commit with `git -c user.name="sweiss105" -c user.email="<the address on existing commits>" commit …`.
- Tests import the engine from TypeScript source (the `source` export condition), so no build is needed before `npm test`.

### Sandbox server (never touch the real porch while testing)

Run a throwaway server on its own port with a copy of the show whose controller host is the dummy address **192.0.2.1** (nothing answers there) and `output.enabled: false`:

```sh
PORT=8099 HOST=127.0.0.1 XMAS_CONFIG=/path/to/scratch/show.json npm start
```

`scripts/e2e-smoke.mjs` does the same automatically (port 8097, or `E2E_PORT`). Never send writes to port 8090: that's the live app driving the house.

### Browser tests (Playwright)

Headless Chromium needs system libraries the server doesn't have, and installing them needs root. The workaround:

- Chromium headless shell is cached in `~/.cache/ms-playwright/chromium_headless_shell-1255`, which matches `playwright@1.65.1`.
- A scratch install of that Playwright and the unpacked libraries are under a session scratchpad, e.g. `/tmp/claude-1000/-home-weissaudio-christmas-lights-server-app/<session>/scratchpad/pw/` (`node_modules/` and `libs/usr/lib/x86_64-linux-gnu`). `/tmp` can be cleared, so look for them first and recreate if gone.
- Run: `npm run build:web && LD_LIBRARY_PATH=<…>/pw/libs/usr/lib/x86_64-linux-gnu PLAYWRIGHT_MODULE=<…>/pw/node_modules/playwright npm run e2e`.
- The "demo spot is filmed and decoded" step can fail when the machine is busy; a re-run usually passes (a fix is in progress).

### Deploying

1. Check the owner isn't using it: `GET http://127.0.0.1:8090/api/status` (is `output.enabled` on, a playlist playing?) and `docker compose logs --since 15m` for outside requests. If they're streaming, **ask before restarting**. A restart briefly hands the porch to WLED playlist 26, which the owner accepts.
2. Make a clean worktree of the exact commit to deploy (not the shared checkout, which may hold someone else's uncommitted work).
3. Build the image from it: `docker build -q -t christmas-lights-server-app-xmas <worktree dir>`.
4. From the main folder (where `.env`, `docker-compose.yml` and `data/` are): `docker compose up -d --no-build`.
5. Check `GET /api/status`: fps about 40, controller online, `homeassistant.connected` true.

## What's open

### In progress (other sessions, 2026-11-25)

- Camera views that fit the house.
- A flaky e2e mapping step.
- Fade times per playlist entry.
- Mapping decoder improvements.

### Needs the owner at home

- **Mapping night test** from 3–5 m out (script below).
- **Second controller:** not running yet; its strings (trees, bushes) will need runs and mapping.
- **Big-stairs handrail string:** planned; its GPIO, pixel count and starting end aren't known yet.

### To decide

- Whether Home Assistant or the app's own schedule turns the lights on and off each night (the app's schedule is ready but disabled).

### Later

- Redo the porch layout from better scans or mapping, fixing the left-string start (0–90) and the bottom runner (about 670–820).
- Phases 4–5 and the 2027 music timeline (`docs/PLAN.md`).

## Camera mapping reference

Mapping finds where each light really is: the lights flash coded patterns while the owner films the house with the iPhone from a few spots, in the web app (`/#map`, or the camera button). It's mainly for strings that aren't placed yet (the big-stairs handrail, the second controller's trees and bushes). The porch, placed from the house model, is the reference that tells each spot where the phone stood.

### How it works

**1. The sequence** (`packages/server/src/mapping.ts`; the shared plan is `packages/engine/src/mapping/sequence.ts`). `POST /api/mapping/start` takes over the output, as Identify does, then the show comes straight back. Each pattern is held for `holdMs`:

1. Lead-in: 1.8 s dark.
2. Preamble: every light blinks a Barker-7 code (on, on, on, off, off, on, off). The phone finds the timing from this, so clocks only need to agree within ±0.8 s.
3. Each pass: a dark background frame, a reference frame with this pass's lights on, then each bit of the lights' codes shown as itself and inverted. Codes are Gray code plus a parity bit.

In a pass only every `k`th light of each run lights, so the camera can tell them apart; each pass starts at a different offset. Lights show white at master brightness × `level`.

Defaults: `k` 10, 2 passes, hold 250 ms, level **25%** (full brightness bloomed). The screen also offers every 14th, 20th or 30th light, 1–4 passes, and holds of 250, 400, 500 or 750 ms. **Test brightness** (`POST /api/mapping/preview`) holds the lights steady while the level slider moves.

**2. Filming and decoding** (on the phone: `packages/web/src/mapping/`, decoder `packages/engine/src/mapping/decode.ts`).

- Frames go to a Web Worker, scaled to 1280 px wide; if decoding falls behind, frames are skipped rather than piled up.
- Frames near a pattern change are skipped (blur, rolling shutter).
- Reference minus background gives bright spots; for each spot and bit, the bit frame is compared with its inverse there, which cancels auto-exposure drift.
- A spot is dropped if any bit is unclear (margin under 0.3), the parity is wrong or the code isn't in use, rather than becoming a wrong light.
- Camera settings (`cameraControl.ts`): pick the camera, the wide zoom, 30 or 60 fps, and lock what Safari allows at Start. The screen reports what the camera accepted.
- Each spot's findings, its camera and decoder stats (`blobs`, `decoded`, `unclear`, `badParity`, `syncScore`, `offsetMs`) are saved in `/api/mapping/views`. Optionally the footage too, in `/api/mapping/recordings`. Spots can be solved again without filming again.

**3. Solving** (in the browser: `pose.ts`, `triangulate.ts`, `solve.ts`; no extra dependencies).

1. Each camera is placed from the lights of *trusted* runs it saw: RANSAC over DLT samples plus starting guesses (the yard, and close spots at 1.5 and 3 m all round), refined with Levenberg–Marquardt under a robust loss. Each spot tries the main camera's (68°) and the ultra wide's (106°) view; one radial distortion term is fitted when there are enough points. Spots share a focal length only when filmed with the same camera, or when their estimates agree. Tolerances scale with the picture (1.6% of the long side for the camera, 0.6% for measured lights).
2. Lights seen from two or more spots are triangulated (rays meeting at 3° or more).
3. Lights seen once go on their ray, nearest to where measured neighbours put them, or where the ray meets the house model.
4. Each measured run is filled in: outliers dropped, the rest keep the run's shape (its coil) shifted onto the measured lights.

**4. Review and save** (`MapReviewPanel.tsx`), Blind-style: nothing changes until Save. Mark each string *Trusted* or *Measure*; check per-spot error and view angle, the trusted-light check, and how far each measured string moves. Save makes a backup (`before-mapping-<time>.json`) and writes per-pixel `positions` into the runs through Layout's history. A run placed this way says so in Layout, locks its pixel count and hides its path; "Use the drawn path" drops the positions.

### Testing without lights

- Unit and simulation tests: `npx vitest run packages/engine/test/mapping-*.test.ts packages/server/test/mapping.test.ts packages/web/test/mapping.test.ts`. `mapping-real.test.ts` covers what the first night taught (close spots, a distorting wide lens, mixed lenses).
- `/#map-demo` runs the whole screen on a simulated camera; nothing is sent to the lights or saved.
- `npm run e2e` films one demo spot and opens Review.

### Night test script (next run, with the owner)

**At the server first:**
1. Check `GET /api/mapping` answers `{"active":false,…}` and streaming is on. Make sure nothing turns streaming off during the test.
2. On the iPhone, open xmas.weiss-audio.com/#map-demo once to see the flow work.

**Filming:**
1. Open `/#map` and allow the camera. Use the wide zoom if the porch doesn't fit at 1×. Lock white balance (the only lock Safari allows). Hold the phone sideways and keep it still on a support or tripod for the whole sequence.
2. Use **Test brightness** to pick a level where the lights are clear but not blooming (start at 25%).
3. Film from each of these, **3–5 m from the porch**, each seeing the rails in depth:
   - the top of the front walk;
   - the lawn, front-left;
   - the lawn, front-right;
   - a tripod raised over the hedge.
4. Leave footage recording on (the default), so a failed spot can be studied afterwards.

**Review:** set one porch run to Measure and keep the other Trusted, then swap. Each spot should be placed with an error of a few pixels and a sensible view angle; trusted lights measured again should land within about 3 cm.

**Don't save the porch.** The owner keeps the model layout for now. The point of this test is to prove the spots solve, ready for new strings. For a new string: add its run in Layout with a rough line, film 3 or more spots that see it and a good part of the porch, set it to Measure, Save, then check with a sweep scene.

**If decoding struggles:** raise the level, space the lights wider (every 14th or 20th), or hold each pattern longer (400–750 ms).

**Backing out:** Cancel stops the sequence at once; it also ends by itself (never more than 180 s), and `POST /api/mapping/stop` ends it. After a Save, Undo in Layout then Save layout, or restore `before-mapping-…` from Backups. Spots can be deleted from the list or with `DELETE /api/mapping/views`.

## Paint mode reference

- A layer may carry `paint`: one byte per global pixel (base64, trailing zeros dropped) that multiplies into its weight. Paint shorter or longer than the layout is fine, so scenes survive a layout change. Presets never store paint.
- A stroke adds to the painted layer with the brush's look (or makes a new one on top) and wipes those lights on painted layers above it, so the newest stroke shows. Erase wipes all painted layers; ordinary layers are never touched.
- Strokes go through the scene editor's history, one undo step each. With Live armed on the scene on stage, strokes show on the porch as they're drawn.
- `Engine.setScene` keeps a layer's running effect when only its paint, opacity, blend or group changed, so effects don't restart on every brush move.
- The brush paints through: lights behind those under the brush are painted too. Turn the view to paint one side only.

## Known gaps and things to watch

- Health checks run every 10 s, so a controller offline at startup shows `online:false` until the next check.
- `GET /api/frame` renders on demand, so it works with streaming off.
- Wi-Fi load: 3 UDP packets per frame for 1101 pixels (about 135 KB/s at 40 fps); about double once the second controller is added.
- The server needs outbound UDP 4048 (DDP), UDP 5353 (mDNS) and TCP 80 to the controllers.
- The glow on the house hasn't been measured on a real phone or iPad GPU. If it's heavy there, turn it off by default on touch devices.
