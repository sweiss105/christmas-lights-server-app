# Public demo at demoxmas.weiss-audio.com

Status: design, awaiting the owner's approval (2026-11-26).

## Intent

A public demo of the whole lights app, so anyone (friends, neighbours, people the owner shows it to) can open
`https://demoxmas.weiss-audio.com`, look around the Control and Create pages, play scenes and playlists, and try edits live,
without signing in. The demo house has more lights than the real porch, to show what the app can do with a bigger
display: spirals round the mailbox, a spiral along the handrail of the big cement stairs, and lights in the bushes.
These extra strings exist only in the demo.

The demo never has access to the real lights, and the real site (`xmas.weiss-audio.com`, behind Cloudflare Access)
does not change how it is reached.

## Goals

- The Control and Create pages work in the demo (Setup is left out entirely), starting from the owner's current show: all
  scenes, playlists, presets, saved palettes, the house model, and the real porch strings.
- Extra demo-only strings, placed on the scanned house model's own parts:
  - **Mailbox:** a spiral up the mailbox post, then a spiral round the mailbox box along its length.
  - **Stair handrail:** a spiral along the top rail of the handrail beside the cement stairs.
  - **Bushes:** net-style lights draped over the four bushes in front of and beside the porch.
- The extra strings light up in the existing scenes (see "Scenes and the extra strings").
- **Look, don't save (owner's pick).** Visitors can Go, play and stop playlists, Blackout, change brightness, and
  edit in Create in Blind or Live, painting included. Save, Save as new, Delete, Rename, Duplicate and every other
  change to stored things are turned off.
- Each visitor's Go, Live preview and playlist affect only their own browser tab. Two visitors never see each
  other's actions.
- Open to everyone: no login, no Cloudflare Access on `demoxmas.weiss-audio.com`.
- The demo follows the real show: a scene the owner adds on the real site appears in the demo on the next page
  load, with no deploy.

## Non-goals

- Saving anything for visitors (no accounts, no per-visitor storage beyond the open tab).
- Any change to how `xmas.weiss-audio.com` is reached or to its Access rules.
- Lights on the hedge down the right side of the lawn (the owner asked for the bushes; the hedge can be added the
  same way later).
- Anything from the Setup page in the demo: Strings, House, Map, WLED, Backups and Home (the owner's decision).
- Making the extra strings real (they have no controller).

## Anti-goals (a failure even if the demo works)

- Anything reachable from `demoxmas.weiss-audio.com` that can write the real show file, stream to or probe the
  porch controller, reach Home Assistant, or make requests into the home network.
- Leaking private details to the public: the home's latitude and longitude (stored for the sunset schedule), the
  controller's LAN address, Home Assistant settings, backups, camera mapping footage.
- Making the real app riskier: the real site's bundle and server code paths must not change behaviour because the
  demo exists.

## Approaches considered

1. **A second copy of the server in demo mode.** Same app in a second container with a demo switch that disables
   output and refuses writes, reading the real show file. Uses the real playlist and fade code. But the server keeps
   one stage for everyone, so stage, Go, Live, playlists and brightness would all need per-visitor tracking (surgery
   on the code that drives the porch), and a whole server would be on the public internet with every write and
   LAN-reaching route (controller probe and discovery, identify, mapping) needing to be found and locked.
2. **The demo runs in the visitor's browser (chosen by the owner).** The web app is built a second time with a demo
   switch. Every request the UI makes already goes through one function (`call()` in `packages/web/src/api.ts`); in
   the demo build, a stand-in in the browser answers those requests instead of the network, starting from a
   snapshot of the show. A tiny container serves only the built files, the snapshot and the house model. Each tab
   has its own stage by construction; the public part is read-only files; the real server's code is untouched. Cost:
   the stand-in imitates the server's answers and could drift as the app grows (tests guard this).
3. A static copy on Cloudflare Pages was dropped: the snapshot would only update on a manual publish, so the demo
   would fall behind the owner's scenes.

## Design

### Pieces

```
demoxmas.weiss-audio.com ── Cloudflare tunnel (new public hostname, no Access) ──▶ 127.0.0.1:8091
                                                                                   xmas-demo container
                                                                                     ├─ GET /             built demo UI (packages/web/dist-demo)
                                                                                     ├─ GET /demo/show.json   snapshot (built from /data/show.json, read-only)
                                                                                     └─ GET /api/house/parts/:id/model   the house .glb files (read-only)
browser tab: demo UI ── api.call() ──▶ in-browser stand-in (state lives in the tab only)
```

### 1. The demo snapshot (`/demo/show.json`)

Built by the demo server from the real `/data/show.json` (mounted read-only) plus a file of demo extras kept in
the repo (`config/demo-extras.json`). Rebuilt when `show.json` changes (check its modification time per request
and cache the result). If `show.json` can't be read or parsed, keep serving the last good snapshot; if there never
was one, answer 503 and the UI shows a friendly "demo unavailable" message.

What it contains:

- `layout`: the real controllers and runs with each controller's `host` replaced by `demo.invalid`, plus a demo
  controller (`id: "demo"`, `host: "demo.invalid"`) and the extra runs on it. Groups: the real groups, plus
  `mailbox`, `stair-rail`, `bushes`, and `porch` widened as described below. The merged layout must pass
  `buildLayout` (the snapshot builder runs it and refuses to publish a layout that fails).
- `scenes`, `playlists`, `presets`, `palettes`: copied as they are.
- `activeScene`, `stage` (the scene on stage when the snapshot was taken, if it's a stored one): so the demo opens
  showing what the porch shows.
- `output`: brightness, gamma, transition only.
- `house`: the house transform and parts (ids, names, transforms, visibility, `uploadedAt`); file names stay server
  side.
- `schedule`: left out entirely (it holds the home's coordinates).
- Left out: `playing`, `lastScene`, `scheduleInWindow`, and anything not listed above (Home Assistant, mapping,
  backups). The builder is an allow-list, not a strip-list, so a field added to the show file later is not published
  by accident.

### 2. The extra strings (`config/demo-extras.json`)

Positions come from the named parts of the scanned house model (`data/house-part2.glb`), in the same metres the
porch runs use. Measured from the model:

| Part | Where (x, y, z in m) |
|---|---|
| `mailbox_post` | 0.09 m square post, centre (2.485, ·, 2.285), y from −0.27 (ground) to 0.96 |
| `mailbox` | box x 2.39–2.58, y 0.96–1.24, z 2.14–2.86 (long axis along z) |
| `handrail` | top rail from (2.26, 0.77, 3.30) down to (2.26, −0.66, 6.05), about 4 cm thick, 3.1 m long |
| `bushes` | four bushes: (a) x −5.00…−3.88, z −1.54…0.14, up to y 1.19 (beside the porch's left end); (b) x −3.56…−2.92, z −0.02…1.32, up to 1.54; (c) x −2.40…−0.38, z −0.02…1.32, up to 1.54 (wide); (d) x 0.16…0.83, z −0.02…1.30, up to 1.44 (left of the porch steps). Ground around y −0.1. |

Runs (pixel counts are the builder's to tune for looks; these are starting points):

- `mailbox` (~150 px): one coiled run, points post bottom → post top → box front end → box back end, with the
  short hop from the post top to the box skipped (`coil.skip`). Post coil radius ~0.07 m, pitch ~0.12 m; box coil
  radius ~0.16 m, pitch ~0.1 m. The `coil` config has one radius and pitch per run, so if one value can't look
  right for both, split it into two runs (`mailbox-post`, `mailbox-box`), both in the `mailbox` group.
- `stair-rail` (~250 px): coiled along the handrail's top rail, radius ~0.035 m, pitch ~0.15 m.
- `bush-a` … `bush-d` (~100, 100, 200, 100 px): `positions` lists (one point per light) generated once by a script
  and written into the extras file: points spread evenly over the upper part of a dome that fills each bush's box,
  pushed a few centimetres out from the surface, in a gently zig-zagging order so a chase runs across each bush the
  way a net would. The generator script stays in `scripts/` so the bushes can be regenerated.

Groups: `mailbox` (mailbox runs), `stair-rail`, `bushes` (all four), `demo-extras` (all of them).

### 3. Scenes and the extra strings

52 of the 56 layers in the real scenes are limited to the group `porch`, so unchanged they would leave every extra
light dark. In the snapshot, `porch` is widened to the real porch runs **plus all extra runs**, so every existing
scene plays across the whole demo display. The real porch keeps its own group as `porch-real` for anyone building a
scene in the demo. Effects work in the display's normalised 3D space, so adding lights out at the mailbox and stairs
stretches sweeps and waves over the larger area, which is the point.

### 4. The demo build of the web app

- A build-time switch: `vite build --mode demo` (script `build:web:demo`) writes `packages/web/dist-demo`, with a
  compile-time constant (e.g. `__DEMO__`) that is `false` in the normal build, so the real bundle contains no demo
  code at all.
- `call()` in `api.ts`: when `__DEMO__`, hand the request (method, path, body) to the stand-in instead of `fetch`.
  The two raw-`fetch` methods (`uploadHousePart`, `uploadRecording`) refuse in the demo.
- The house model keeps loading from `/api/house/parts/:id/model?v=…`, which the demo server serves as a plain
  file, so `HouseModel.tsx` needs no change.

### 5. The in-browser stand-in

One module (`packages/web/src/demo/backend.ts` or similar) that loads `/demo/show.json` once per page load and
then answers every request in `api` from memory. State lives in the tab and is gone on reload; reloading starts
fresh from the snapshot.

| Requests | Demo answer |
|---|---|
| `status`, `stage`, `scenes`, `scene`, `layout`, `groups`, `playlists`, `presets`, `palettes`, `house`, `output` | From the tab's state, in the same shapes the server sends. `groups` comes from `buildLayout` on the snapshot layout. `status.stream` reports running at 40 fps with one healthy controller named "Demo (no real lights)"; `homeassistant` is `{ enabled: false }`; `schedule` is null. |
| `effects` | Built from the engine's `EFFECTS` in the browser, the same way the server lists them (share the mapping code if it's simple to). |
| `clock` | Seconds since the page loaded (the preview only needs a steady clock). |
| `go`, `blackout`, `previewStage`, `endPreview` | Change the tab's stage exactly as the server does (preview validates the scene the way a save would, with the engine's own validation where it can be reused). |
| `playPlaylist`, `stopPlaylist` | Start or stop a playlist in the tab; which scene is on stage and `status.playlist` are worked out from the start time with the pure functions in `packages/server/src/show.ts` (move or re-export them so the web package can import them without pulling in server code). |
| `setOutput` | Brightness and the streaming switch change in the tab only. |
| `identify` | `{ run: null, streaming: false }`, no effect. |
| `schedule` | `{ enabled: false }`. |
| Everything that stores, renames or deletes (`saveScene`, `renameScene`, `deleteScene`, presets, palettes, playlists, `saveLayout`, house edits, `saveSchedule`, backups, restore, mapping, `discoverControllers`, `login`) | Refused with `ApiError(403, "This is a demo: saving is turned off.")` (wording the builder's to polish), so anything the UI forgets to disable fails with a clear message rather than silently. Setup-only reads (`backups`, `mappingViews`) are refused too, since no demo page asks for them. |

Crossfades: the stand-in records the transition the way the server reports it; whatever the browser preview does
with a Go on the real site, it does the same in the demo. No new fade rendering.

Guarding drift: a test walks every method of `api` and asserts the stand-in answers it (or refuses it on purpose,
from an explicit list), so a new API method added later fails the demo tests until someone decides what the demo
does with it.

### 6. What visitors see

- A slim, always-visible ribbon at the top: "Demo: nothing here is connected to real lights, and saving is off."
  (Wording to polish; it must fit the phone layout.)
- Buttons that store, rename or delete are disabled in the demo with a tooltip ("Saving is turned off in the
  demo"): Save, Save as new, Delete, Rename, Duplicate for scenes; save and delete for playlists, presets and
  palettes; the schedule's save; the Select tool's Save, Update and Delete group buttons (the owner chose strictly
  no saving: visitors can select lights but not keep the selection as a group, even for the visit). Anything missed
  is still refused by the stand-in.
- Unsaved edits: the "unsaved changes" prompts offer only Discard and Cancel in the demo (no Save choices), and
  closing the tab doesn't warn.
- **No Setup page (owner's decision).** The demo has only Control and Create: the page switcher doesn't offer
  Setup, and any Setup address (`#/setup…`, `#map`) opens Control instead. Nothing from Setup (Strings, House, Map,
  WLED, Backups, Home) appears anywhere in the demo, including links to it from other pages (e.g. a "set up the
  house" hint on Control). The extra strings are still visible as lights in the 3D view; they just can't be
  inspected or edited as strings.
- Everything else is the real app: Control, Create (Move, Select, Brush, Eraser), Blind/Live/Go, playlists.

### 7. The demo server and container

- New entry `packages/server/src/demo.ts` (its own small Fastify app, sharing nothing stateful with `api.ts`):
  serves `dist-demo` at `/`, `GET /demo/show.json`, and `GET /api/house/parts/:id/model` (looks up the part by id in
  the real show's `house.parts`, streams that file from `/data`; unknown id → 404; never builds a path from the
  request). It answers only GET and HEAD; anything else is 405. It has no API token and never sets cookies. No DDP,
  no WLED, no mDNS, no MQTT, no writing anywhere.
- `docker-compose.yml` gets a second service, `xmas-demo`, from the same image, command running `demo.ts`:
  - port `127.0.0.1:8091:8091` on Docker's default bridge network (not host networking), so it is not on the LAN
    directly and only the local tunnel reaches it;
  - `./data:/data:ro`, a read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, modest memory and CPU
    limits;
  - none of the real service's secrets (no `XMAS_API_TOKEN`, no MQTT variables).
- The Dockerfile also builds `dist-demo`.

### 8. Cloudflare

- Add the public hostname `demoxmas.weiss-audio.com` → `http://127.0.0.1:8091` on the existing tunnel
  (`weissaudio-home-server`), **without** the per-hostname "Access required" setting the real hostname has. This
  also creates the DNS record. Before adding it, check that no wildcard Access application (e.g.
  `*.weiss-audio.com`) would catch the new hostname. **Ask the owner before making this change.**
- `demoxmas` is a single-level name under `weiss-audio.com`, so the existing certificate covers it.

### 9. Testing

- Snapshot builder: leaves out the schedule and coordinates, replaces controller hosts, copies scenes/playlists/
  presets/palettes, merges the extras, widens `porch`, the result passes `buildLayout`, a broken `show.json` keeps
  the last good snapshot, an unknown future field is not published.
- Stand-in: answers every `api` method (the drift test above); Go, Blackout, Live preview, playlists and brightness
  behave like the server (compare against the server's own tests where practical); every storing method refuses.
- Demo server: only GET/HEAD; house model by id only; no path traversal; 503 without a snapshot.
- Extras: each extra run's lights sit within a few centimetres of its scanned part.
- Browser: build both bundles, run the e2e smoke test against the demo server (Control renders the house with the
  extra lights; Go changes the preview; Save is disabled). The real bundle contains no demo code (e.g. grep the
  built files for the demo ribbon text).
- Screenshots of the demo at desktop and phone widths for the owner.

### 10. Rollout

1. Build and test on the `demo-site` branch in its own worktree. Try the demo there by running the demo server
   straight from the worktree with Node (not Docker) on `127.0.0.1:8091`, pointed at the real `data/` folder
   read-only. The live container is not touched.
2. PR to main. The live container belongs to the compose project in the main checkout and shares one image with the
   demo, so nothing is deployed from the branch: deploying from it would put unmerged code on the porch, and a later
   rebuild from `main` would drop the demo files.
3. Once merged, deploy from the main checkout with `docker compose up -d --build` when the real site is idle (the
   real container restarts too, since it shares the image), and check the demo on `127.0.0.1:8091`.
4. With the owner's go-ahead, add the tunnel hostname, then check `https://demoxmas.weiss-audio.com` from outside
   without signing in, and check that `xmas.weiss-audio.com` still asks for a login.

## Decided by the owner

- A demo of everything, with extra lights on the mailbox (spirals), the handrail by the big stairs and the bushes,
  only in the demo; no access to the real lights.
- Public, with no login, on its own hostname `demoxmas.weiss-audio.com`; the real site's access unchanged.
- Visitors can look and try, but not save (Save and Delete off).
- Strictly no saving, not even for the length of a visit: the Select tool's group buttons are off too.
- No Setup page at all in the demo: only Control and Create.
- Built as a browser-side demo (approach 2).

## My calls (owner to check)

- Each visitor's actions stay in their own tab (needed for a public demo where nothing is saved).
- The `porch` group widens in the demo so the existing scenes light the extra strings.
- The demo follows the real show automatically (snapshot rebuilt when the show file changes).
- Home coordinates, the schedule, controller addresses, Home Assistant, mapping and backups are not published.
- No hedge lights.
- Nothing is deployed from the branch: test outside Docker, PR, then deploy from `main` after the merge.

## Left to the builder

Exact pixel counts, coil radii and pitches; the bush point pattern; ribbon and tooltip wording; where the shared
playlist functions move to; file and module names; how the demo build flag is wired; container resource limits.
