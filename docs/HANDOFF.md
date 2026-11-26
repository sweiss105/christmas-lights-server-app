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

**Show automation and upkeep (done, live):**
- **Playlists** (`/api/playlists`) and a **nightly schedule** (`/api/schedule`, sunset or a fixed time, in a time zone), both run on the server. The logic is in `packages/server/src/show.ts`.
- **Backups:** download and restore, plus daily automatic backups in `data/backups/` (last 14 kept). Every restore first saves the current state.
- **House scans can come in several parts**, each aligned separately (`/api/house/parts`). The owner scanned the house with Polycam in two parts.
- **Speed:** long-lived caching for hashed UI files, and a split bundle.
- **`npm run e2e`:** a browser smoke test (see `scripts/e2e-smoke.mjs`).

**Selection, the real house and coiled strings (done, live):**
- **Select tools:** box, lasso, brush, tap-a-string, and rules (every Nth, string ends, height, house half). Selections save as groups, optionally with a soft edge (`feather`). Done, Esc or picking a scene goes back to the editor.
- **House model:** the owner's own clean model (`House_Clean.glb`, built from the Polycam scans, metres, Y up, +Z towards the street, named parts such as `railings`, `handrail`, `cement_stairs`). The latest version (door moved) is live; copies are in `~/scans/` on the server.
- **Untextured models get a clay look:** lit, matte, outlined edges, a dim night sky. Textured photo scans keep the unlit look. With a house shown, the flat ground at 0 m is left out (the yard slopes about 2.5 m down to the street) and layout points may go below 0 m.
- **Coiled runs:** `coil: { radius, pitch, skip }` on a run winds its lights round the path (one turn per baluster gap, 0.27 m), with `skip` segments straight (e.g. down a post). Edited in the Layout panel.
- **The porch strings now follow the model's railings** (owner confirmed which sections, 2026-11-24): GPIO16 starts on the left side rail 0.5 m from the house, then the front and the left stair rail (7.8 m). GPIO12 goes up the right stair rail, along the front and the right side to the house, straight down the post, then back along the bottom rails (8.9 m). Coiling the bottom rails is a guess to confirm on the porch.

**Still open:**
- Light glow from the LEDs onto the house model (preview only), being built.
- Check the new layout on the real porch at night, including the bottom-rail coil.
- The schedule needs the owner's location (for sunset) and time zone.
- A string on the big-stairs handrail is planned; its GPIO, pixel count and start end aren't known yet.
- The second controller isn't running yet.
- **Phase 3 (camera mapping) is built** on branch `phase-3-camera-mapping` and needs its first night test: see the next section.
- Engine tests fail to load while effect files are half-written. Verify agent work in a clean worktree (`git worktree add` + `npm ci`) before committing.

## Phase 3: camera mapping (built 2026-11-24, branch `phase-3-camera-mapping`; not yet tried on real lights)

This finds where each light really is: the lights flash coded patterns while the owner films the house with the iPhone from a few spots, in the web app.

It's mainly for strings that aren't placed yet: the big-stairs handrail, and trees and bushes on the second controller. The porch is already placed from the house model. It serves as the reference that tells the phone where it was standing.

### How it works

**1. The sequence.** The server code is in `packages/server/src/mapping.ts`; the shared plan is in `packages/engine/src/mapping/sequence.ts`.

`POST /api/mapping/start` takes over the output, as Identify does, and plays a timed sequence. Then the show comes straight back. Each pattern is held for `holdMs` (250 ms by default):

1. **Lead-in:** 1.8 s dark.
2. **Preamble:** every light blinks on/off in a Barker-7 code (on, on, on, off, off, on, off). The phone finds the timing from this, so it doesn't have to trust clocks.
3. **Each pass:**
   - a background frame, all dark;
   - a reference frame, with this pass's lights on;
   - each bit of the lights' codes, shown as itself and then inverted. Codes are Gray code plus a parity bit.

In a pass only every `k`th light of each run lights, so the lit ones are far enough apart for the camera to tell them apart. Each pass starts at a different offset.

The lights show white at master brightness × `level`, through the normal output curve.

**2. Filming and decoding.** This runs on the phone. The screen is in `packages/web/src/mapping/`; the decoder is `packages/engine/src/mapping/decode.ts`.

1. Map lights syncs with the server clock and starts the sequence.
2. Every camera frame goes straight to a Web Worker, so only a few seconds of frames are held at once. Frames come from `requestVideoFrameCallback`, scaled to 1280 px wide.
3. The worker slides the preamble along the picture's brightness to find the true start. The clock only has to be within ±0.8 s.
4. Frames near a pattern change are skipped (blur, rolling shutter).
5. The reference frame minus the background frame gives bright spots. Specks smaller than a light (under 3 pixels at 640 px wide, more in a bigger picture) and spots bigger than 1/600 of the picture (glare) are left out. Only the spots' pixels are kept from each bit frame.
6. For each pixel and bit, the decoder compares the bit frame with its inverse, relative to that pixel's on/off swing. This cancels auto-exposure drift and needs no global threshold.
7. A spot that reads one code is one light; it's read again from its summed pixels, and its weighted centre is the light's position. A spot whose pixels show two or more codes is lights touching: each code's pixels are read again as a light of their own (the mixed pixels between them count towards the nearest one's centre). A reflection mixes several lights' codes, so its pixels read nothing clear and it's ignored.
8. A light is dropped if any bit is unclear (margin under 0.3), its parity is wrong or its code isn't in use. Exception: a single bit whose two frames show no difference at all is restored from the parity. On the first night the lights twice missed a pattern change (probably a Wi-Fi hiccup), which lost a whole pass; codes have even parity, so two lights mixed together always leave two or more bits unclear and are still dropped.
9. The same code in two places (a light and its reflection): the one with a clearly brighter peak, or clearly more light, wins; otherwise both are dropped.
10. What was found (pixel → position in the picture) is saved per spot on the server, in `/api/mapping/views` (the file `mapping-views.json` next to the state file). Positions can be solved again at any time without filming again.

**3. Solving.** This runs in the browser (`pose.ts`, `triangulate.ts`, `solve.ts`), with no extra dependencies.

1. **Where each camera stood** is worked out from the lights of *trusted* runs that it saw:
   - RANSAC over DLT samples of 10, plus starting guesses from typical spots in the yard (so a nearly flat set of reference lights works too);
   - refined with Levenberg–Marquardt (rotation, position and focal length) under a robust loss;
   - then all spots share one focal length.
2. **Lights seen from two or more spots** are triangulated. The rays must meet at 3° or more, and each light must land within 4 px of where each spot saw it.
3. **Lights seen from one spot** go on their ray, nearest to where their measured neighbours put them. With no measured neighbours, they go where the ray meets the house model; this is less certain.
4. **Each measured run is filled in:**
   - lights that don't fit the wire are dropped (they're further from their neighbours than the string's spacing allows);
   - the remaining lights keep the run's current shape (its coil, say), shifted smoothly onto the measured lights.

   So a run measured at every 5th light still gets a position for every light.

**4. Review and save.** This works Blind-style (`MapReviewPanel.tsx`): nothing changes until Save.

- **Roles:** the owner marks each string *Trusted* (it places the cameras) or *Measure*.
- **The 3D view** shows the layout with the measured positions. White rings mark lights measured from two or more spots; amber rings mark lights seen from one.
- **For each spot:** lights found, whether its camera was placed, the error in pixels and the field of view.
- **Check:** how far the trusted lights land from their layout positions when measured again.
- **For each string:** how many lights were measured, seen from one spot or filled in, their spacing, and how far the string moves.
- **Save:** a backup is made first (`before-mapping-<time>.json`). Then per-pixel `positions` are written into the chosen runs through the Layout editor's history. To take it back, Undo in Layout, then Save layout.

### Choices and numbers

**K = 10, 2 passes:**
- The porch lights are 1.3–1.8 cm apart along the wire.
- From 10 m, at 1280 px wide and the iPhone's ~68° view, a picture pixel is about 1 cm. A light at night is a blob of 3–6 px.
- Every 10th light is 13–18 cm along the wire (half a coil turn), which is well apart. Every 8th gets tight from 15 m.
- Two passes measure every 5th light (about 7 cm). The ones between come from the run's shape.
- Use every 14th or 20th light for far spots or where a string bunches up (trees). Use 1 pass for speed, or 4 for denser measurement.

**Hold 250 ms:**
- At about 30 fps, that leaves about 4 clean frames per pattern after skipping 60 ms either side of each change.
- The skip covers the rolling shutter, exposure, Wi-Fi and DDP jitter, and the sync error.
- Use 400 ms if iOS drops to 15–20 fps in the dark, or on a weak Wi-Fi link.

**Time per spot:**
- About 13 s for the porch: 1.8 s lead-in, then 7 preamble frames, 2 × 18 pattern frames and 1 end frame at 250 ms each.
- About 15 s with about 2900 lights (9-bit codes).
- One light at a time would take over 1100 frames, about 4.5 minutes per spot.

**No dark frames between patterns:** after the preamble the phone knows the timing, so it skips frames near a change. Dark gaps would only add time.

**Simulated results** (`packages/engine/test/mapping-solve.test.ts`):
- The setup: 3 spots at 960×540, with noise, jitter, 3% dropped frames, rolling shutter, hand shake, 8% hidden lights, and the porch model off by up to ±1 cm.
- Cameras are placed within about 5 cm, with the field of view within 0.3°.
- New strings are measured to 5–7 mm median and 1.1 cm p90. Filled-in lights are 0.5–0.7 cm off (median).
- Real video will do worse: compression, bloom, focus hunting, and a hand instead of a simulation.

### Testing without lights

- **Unit and simulation tests:** `npx vitest run packages/engine/test/mapping-*.test.ts packages/server/test/mapping.test.ts packages/web/test/mapping.test.ts`
- **`/#map-demo`:** runs the whole screen on a simulated camera built from the current layout. Nothing is sent to the lights or saved on the server.
- **`npm run e2e`:** films one demo spot and opens Review.

### Night test script (first real run, with the owner)

**Before going outside** (at the server):
1. Deploy the branch. Check that `GET /api/mapping` on port 8090 answers `{"active":false,...}`.
2. Make sure streaming stays on for the whole test: move the schedule's off time later, or test well inside the on window. A running playlist is fine; mapping takes over the output while it plays.
3. Turn streaming on and set brightness to about 50%. Mapping lights at brightness × level, so 30% is probably too dim to read reliably, and 100% blooms.
4. On the iPhone, open xmas.weiss-audio.com/#map-demo once to see the screen working. Press Start, wait for "Found N lights", then close it.

**Part A: porch check** (about 15 minutes). This proves the whole chain on strings whose positions are already known.
1. Open xmas.weiss-audio.com/#map, or tap the camera button in the top bar, and allow the camera.
   - Use the 1× lens and hold the phone sideways.
   - Rest it on something steady (a car roof, a fence post, a tripod if there is one). It mustn't move for about 13 s.
2. **Spot 1:** stand in the yard or on the street, 8–12 m from the porch, in line with the left stair rail. Frame the whole porch at about half the picture's width. Press Start.
   - The screen says "Get ready". The porch goes dark for 2 s, blinks all its lights a few times, then shows sparse patterns.
   - Expect "Found 150–220 lights" and "The camera placed from N trusted lights". The dots on the frozen picture should sit on lights.
3. **Spot 2:** walk 3–5 m to the right, staying at the same distance, and press Start again.
4. **Spot 3:** go further right, past the right stair rail, and press Start again. A 4th spot from higher up (the top of the yard) or lower down (the street) helps with depth.
5. **Review.** Under Strings, set GPIO12 (porch right) to **Measure** and leave GPIO16 Trusted. Check:
   - **Spots:** each should be placed, with an error under about 2 px and a view of 60–75°. A spot that fails says why. If many fail, the porch layout or house alignment is off, or the lights were too dim.
   - **Check line:** trusted lights measured again should land within about 3 cm. Over 5 cm means the layout disagrees with reality, or the solve is shaky.
   - **GPIO12 "moves N cm":** expect a few cm. This is the real test of the model-based placement, including the guessed coil on the bottom rails. Toggle between Now and With measured and look at the bottom rails in 3D. A large move there means the coil or that section is wrong.
6. Swap the roles (GPIO16 Measure, GPIO12 Trusted) and check the same numbers.
7. **Don't save the porch** unless the numbers clearly show the model is off and the owner wants it. Saving replaces the coil paths with fixed positions for each light. To keep the evidence, screenshot the panel. The spots stay on the server in `data/mapping-views.json`, each with its decoder stats.

**Part B: a new string** (about 10 minutes, only once one is up, e.g. the big-stairs handrail):
1. In Layout, add its run (controller, start, count) with a rough two-point line where it is. Save the layout.
2. Film 3 or more spots that each see both the new string and a good part of the porch: left, middle and right, 3–5 m apart.
3. In Review, set the new string to Measure and leave everything else Trusted. Expect most of its lights measured or filled in, a spacing close to the string's real LED spacing, and the 3D view showing it on the stairs.
4. Save positions (a backup is made first). Then run a sweep scene on the real lights to check direction and position.

**If decoding struggles:**
- **"The lights' flashing wasn't clear":** check that streaming is on and the lights are in the picture, and raise the brightness.
- **Few lights found:** get closer, or space the lit lights wider in Settings (every 14th or 20th).
- **Low frame rate in the dark, or a weak Wi-Fi link:** set the hold to 400 ms in Settings.

**Backing out:**
- **While filming:** Cancel or the back button stops the sequence at once.
- **If anything sticks:** the sequence ends by itself (after about 15 s, never more than 180 s). `POST /api/mapping/stop` ends it at once. Turning streaming off hands the porch to WLED playlist 26.
- **After Save:** in Layout, press Undo and then Save layout, or restore `before-mapping-…` from Backups.
- **Spots:** delete them from the list, or delete them all with `DELETE /api/mapping/views`.

**What to watch for on the first night:**
- whether iOS Safari keeps about 30 fps in the dark (the decoder copes with 15 fps or more);
- whether auto-exposure flickers on the all-on blinks (showing each bit with its inverse should absorb it);
- how bright the blobs are at 50%;
- whether the 1× view takes in the whole porch.

Each saved spot keeps its decoder stats (`blobs`, `decoded`, `split` (spots that were lights touching), `repaired` (lights with a bit restored from the parity), `faint` (dim spots and specks with no code: reflections, glints), `unclear`, `tooBig`, `duplicates`, `badParity`, `syncScore`, `offsetMs`). They help tune `minMargin`, the hold time and K afterwards.

## Paint mode (built 2026-11-24, branch `paint-mode`; not yet tried on the real porch)

The owner asked for a brush to paint colours and effects on the lights, with the model as the canvas. A painting is part of a scene, and can be watched live on the porch.

- **Data:** `LayerConfig.paint` is a base64 string, one byte (0–255) per global pixel, trailing zeros dropped (`packages/engine/src/paint.ts`). The engine multiplies it into the layer's per-light weight, inside the layer's group. Paint shorter or longer than the layout is fine, so scenes survive a layout change. Presets never store paint.
- **Strokes** (`packages/web/src/paint.ts`, pure and tested): a stroke is a weight per light from the lights' screen positions, like the Select brush. Going over a light twice in one stroke doesn't build up. Painting adds to the painted layer with the brush's look (same effect, settings, blend) or makes a new one on top, and wipes those lights on painted layers *above* it, so the newest stroke always shows. Paint *below* is left alone so soft edges blend. Erase wipes all painted layers. Ordinary layers are never touched; a painted layer wiped empty is removed.
- **Screen:** `PaintPanel.tsx` and `PaintOverlay.tsx`; the Paint button in the top bar (a brush icon on phones). Strokes go through the scene editor's history, one undo step per stroke, saved once per frame at most. Tuning the effect brush's settings also retunes what it already painted. After Done, each paint is a normal layer in the list (marked *Painted*), with *Fill all lights* to drop the painting.
- **Engine change:** `Engine.setScene` now keeps a layer's running effect when only its paint, opacity, blend or group changed (never during a crossfade). Without that, Fire or a particle effect restarted on every brush move. It also means an opacity drag no longer restarts effects.
- **The brush paints through:** lights behind the ones under the brush (the far side of a coiled rail, a string further back) are painted too. Turn the view with Move to paint one without the other.
- **To try on the porch:** Go a scene, arm Live, open Paint and draw. Watch how it keeps up over Wi-Fi: each frame of a stroke is one scene save.

## Known gaps and things to watch

- **Health-check timing:** they run every 10 s via HTTP to `/json/info`, so a controller that was offline at startup shows `online:false` until the next check.
- **Rendering when streaming is off:** `GET /api/frame` renders on demand, so it works even with streaming off.
- **Wi-Fi load:** about 8 UDP packets per frame (2 controllers × 4), roughly 350 KB/s at 40 fps.
- **Firewall:** the server needs outbound UDP 4048, UDP 5353 (mDNS) and TCP 80 to the controllers.

## After the hardware works

- Fix anything found above, then open a PR from `phase-1-engine-ddp-api` into `main`. Ask the owner first.
- **Phase 2** (see `docs/PLAN.md`): web UI with a 3D preview that runs `@xmas/engine` in the browser, a manual line tool for placing runs, and scene and layer editing. Load the apple-design skill before starting UI work; the owner asked for that.
