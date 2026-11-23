# Delivery plan

Rebuilt on 2026-11-23 from the planning session summary; the original file was lost before it was committed.

**Deadlines:** lights running on the house by **Dec 5**; full editor by **Christmas**.

## Decisions

- TypeScript full stack: a Node.js server plus a React / Three.js frontend. The effect engine is plain TypeScript shared by the server and browser. (Rust and WASM were considered and dropped once the stack moved to TS, since the engine renders 2900 px × 4 layers in about 2 ms.)
- Non-linear effects via spatial coordinates plus custom pixel groups.
- Editor model: layered canvas stage over a 3D preview, plus a timeline.
- Output: DDP at 40 fps to two GLEDOPTO GL-C-618WL WLED controllers. WLED presets are the fallback.
- Reused: Three.js, React Three Fiber, drei, three-mesh-bvh, FastNoiseLite, cloudflared. Hand-written: the DDP sender (no maintained Node package exists).
- Camera mapping: Marimapper (Python, GPL-3.0) in a separate container, talking over files or HTTP, so its licence stays separate.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | TS effect engine, DDP streaming, WLED discovery and health, REST API, persistence, Docker | **Done** |
| 2 | Web UI: 3D preview (shared engine in the browser), manual line tool for placing runs, scene and layer editing, first effects polish | Next. Load the apple-design skill before starting the UI |
| 3 | Camera mapping with Marimapper → per-pixel `positions` on runs | |
| 4 | Canvas stage, masks, remaining effects | |
| 5 | Touch polish (phone and tablet control) | |
| 2027 | Music-synced timeline | |

**Deferred:** Gray-code fast scan, LiDAR-assisted mapping.

## Risks

- **Marimapper is mid-rewrite.** Pin a version and keep manual polyline placement (Phase 2) as the fallback.
- **Wi-Fi throughput and jitter.** 2900 px at 40 fps is about 8 packets per frame (350 KB/s). Use 2.4 GHz with a strong signal, or the controllers' Ethernet if they have it. Watch `sendErrors` and visible stutter, and drop to 30 fps if needed.
- **Firewall.** Outbound UDP 4048 and mDNS (UDP 5353) from the server to the controller VLAN, plus HTTP 80 for the WLED JSON API.
- **Public exposure.** The API controls the lights. Put Cloudflare Access in front of xmas.weiss-audio.com and/or set `XMAS_API_TOKEN`.
