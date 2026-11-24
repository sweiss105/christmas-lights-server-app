# Phase 2 plan: web UI

Written 2026-11-24. Target: the full editor by **Christmas**. Phase 1 (engine, DDP, API, Docker, Cloudflare Access) is done and running on the porch.

## Decisions from the owner

- **Desktop and tablet first.** The layout is built for a large screen with a pointer *and* for touch on a tablet: 44 px minimum hit targets and Pointer Events throughout, with no hover-only controls. A phone layout comes in Phase 5.
- **A lighting-console model: Blind and Live.**
  - **Stage** is what the porch is showing now.
  - **Blind** (the default) is where edits are made. Blind edits are saved, and the 3D preview shows them, but the porch doesn't change.
  - **Go** puts the edited scene on stage.
  - **Live** is a deliberate switch: while it's on, every edit goes to the porch immediately. A clear on-screen indicator shows when Live is armed.
  - **Undo and redo** work in both modes.
- **The 3D preview includes a simple house model** drawn from rough measurements, with the lights placed on it.

## Architecture

- **New package, `packages/web`:** Vite, React and TypeScript, with React Three Fiber and drei for 3D. It imports `@xmas/engine` from source, so the preview runs **the same engine code** as the porch.
- **One origin.** Fastify serves the built UI at `/`, next to `/api`. There's no CORS, and everything stays behind the existing Cloudflare Access app. In development, Vite proxies `/api` to the server.
- **The preview runs in the browser.** The browser renders frames locally at the display's refresh rate, with no frame streaming from the server. A new `GET /api/clock` lets the browser align its effect time with the server's, so the preview and the porch animate in step.
- **State lives on the server.** Blind edits are saved there, not only in the browser, so nothing is lost on refresh or when switching between the tablet and the laptop.
- **Docker:** the build gains a stage that builds the web bundle. The image stays single-container.

### Server changes

| Change | Why |
|---|---|
| `PUT /api/scenes/:name?apply=false` saves without touching the stage | Blind editing; today, saving the active scene updates the porch at once |
| `POST /api/go` with `{scene}` puts a scene on stage; status reports `stageScene` and `stageDirty` | **Go** button, and an "edited in Blind, not on stage" indicator |
| `GET /api/clock` | Keep preview and porch time in step |
| `house` section in the saved state, with `GET`/`PUT /api/house` | House-model dimensions |
| Serve `packages/web/dist` at `/` | One origin |
| `POST /api/runs/:id/identify` (Live only) | Flash one run on the porch while placing it |

## Milestones

Each milestone is usable on its own, merged by PR, and deployed to the container.

### M1 — Stage and preview (about 1 week)
- App shell: top bar with stage status (controller online, fps, errors), master brightness, output on/off, blackout.
- 3D preview: glowing pixels at their real positions, house model v1 (porch floor, railings, stairs, house front), orbit camera with sensible presets (front, porch, top).
- Scene list: tap a scene to preview it in Blind, then **Go** to send it to the porch.
- Clock sync, so the preview matches the porch.

### M2 — Scene and layer editor, Blind and Live (about 1 week)
- Layer stack: add, remove, reorder, enable, opacity, blend mode, and group (whole house, a run or a custom group).
- Effect parameters generated from each effect's `ParamSpec`: colour pickers, sliders, direction (vec3) control, selects.
- Blind (default), Live switch, Go, undo and redo, plus a Stage/Preview toggle on the 3D view to compare the two.
- New, duplicate, rename and delete scenes.

### M3 — Layout tools (about 1 week)
- House model editor: rough dimensions in metres (front width, wall height, roof shape and peak, porch size and position).
- Manual line tool: select a run and click points on the house model's surfaces to draw its path; drag points to adjust; type exact numbers if wanted. Set start pixel and count.
- **Identify** (Live only): flash the selected run on the porch to check it.
- Saving validates the layout and re-renders the preview.

### M4 — Effects pass and polish (the remaining days)
- First effects polish: tune defaults on the real porch, plus 1–2 new effects if there's time.
- Interaction polish following the Apple design guidance: instant press feedback, spring motion that can be interrupted, translucent panels over the 3D view, respect for reduced-motion and reduced-transparency settings, and a dark theme suited to working at night.
- Tests: server API tests for the new routes, unit tests for editor state (undo, Blind/Live), and a browser smoke test.

## Open questions

- **House dimensions for the model (needed by M1, rough is fine):** house front width, height to the eaves, roof shape (gable facing the street, gable to the side, or hip) and peak height, and where the porch sits along the front.
- Whether "Go" should crossfade between scenes or cut. The plan is a **cut** for M1, with a crossfade option in M4.

## Out of scope for Phase 2

Camera mapping (Phase 3), the canvas stage and masks (Phase 4), phone layout and touch polish (Phase 5), and the music timeline (2027).
