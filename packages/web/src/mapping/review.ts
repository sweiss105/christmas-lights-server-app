/** Mapping results: spots kept between screens, the house model for ray casts, and the candidate layout. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { LayoutConfig, Vec3 } from '@xmas/engine';
import { DEFAULT_MAPPING, type RunSolve, type SolveResult, type ViewInput } from '@xmas/engine/mapping';
import { api, type House, type MappingView } from '../api';
import { DEFAULT_CAMERA, type CameraChoice } from './cameraControl';

export type RunRole = 'trusted' | 'measure';

const ROLES_KEY = 'xmas.mapping.roles';
const SETTINGS_KEY = 'xmas.mapping.settings.v2'; // v2: the default light level dropped to 25%

const readJson = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; } };
const writeJson = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

/** Which runs place the cameras (trusted) and which get measured. Unlisted runs are trusted. */
export function useRunRoles(): [Record<string, RunRole>, (id: string, role: RunRole) => void] {
  const [roles, setRoles] = useState<Record<string, RunRole>>(() => readJson(ROLES_KEY, {}));
  const set = useCallback((id: string, role: RunRole) => setRoles((r) => { const next = { ...r, [id]: role }; writeJson(ROLES_KEY, next); return next; }), []);
  return [roles, set];
}

export interface CaptureSettings { k: number; passes: number; holdMs: number; level: number }
export const DEFAULT_SETTINGS: CaptureSettings = { ...DEFAULT_MAPPING };
export function useCaptureSettings(): [CaptureSettings, (s: Partial<CaptureSettings>) => void] {
  const [s, setS] = useState<CaptureSettings>(() => readJson(SETTINGS_KEY, DEFAULT_SETTINGS));
  const set = useCallback((p: Partial<CaptureSettings>) => setS((old) => { const next = { ...old, ...p }; writeJson(SETTINGS_KEY, next); return next; }), []);
  return [s, set];
}

const CAMERA_KEY = 'xmas.mapping.camera';

/** Which camera, frame rate, locks and recording to use; kept on this phone. */
export function useCameraChoice(): [CameraChoice, (c: Partial<CameraChoice>) => void] {
  const [c, setC] = useState<CameraChoice>(() => readJson(CAMERA_KEY, DEFAULT_CAMERA));
  const set = useCallback((p: Partial<CameraChoice>) => setC((old) => { const next = { ...old, ...p }; writeJson(CAMERA_KEY, next); return next; }), []);
  return [c, set];
}

export interface MappingViews {
  views: MappingView[];
  loading: boolean;
  add: (v: Omit<MappingView, 'id' | 'createdAt' | 'layoutPixels'>) => Promise<MappingView>;
  remove: (id: string) => Promise<void>;
}

/** Spots filmed so far: kept on the server, or only in this page in demo mode. */
export function useMappingViews(demo: boolean, pixels: number, onError: (e: unknown) => void): MappingViews {
  const [views, setViews] = useState<MappingView[]>([]);
  const [loading, setLoading] = useState(!demo);
  useEffect(() => {
    if (demo) return;
    api.mappingViews().then((v) => setViews(v), onError).finally(() => setLoading(false));
  }, [demo, onError]);
  const add = useCallback(async (v: Omit<MappingView, 'id' | 'createdAt' | 'layoutPixels'>) => {
    const saved: MappingView = demo ? { ...v, id: `demo${Date.now().toString(36)}`, createdAt: new Date().toISOString(), layoutPixels: pixels } : await api.saveMappingView(v);
    setViews((old) => [...old, saved]);
    return saved;
  }, [demo, pixels]);
  const remove = useCallback(async (id: string) => {
    if (!demo) await api.deleteMappingView(id);
    setViews((old) => old.filter((x) => x.id !== id));
  }, [demo]);
  return { views, loading, add, remove };
}

/** Views as the solver takes them, leaving out ones filmed against a different layout size. */
export function solverViews(views: MappingView[], pixels: number): ViewInput[] {
  return views.filter((v) => v.layoutPixels === pixels).map((v) => ({ id: v.id, width: v.width, height: v.height, detections: v.detections, ...(v.camera && { camera: v.camera }) }));
}

/** The layout with measured positions written into the chosen runs. */
export function applyPositions(layout: LayoutConfig, runs: RunSolve[], chosen: Set<string>): LayoutConfig {
  const byId = new Map(runs.filter((r) => r.positions && chosen.has(r.runId)).map((r) => [r.runId, r.positions!]));
  return { ...layout, runs: layout.runs.map((r) => (byId.has(r.id) ? { ...r, positions: byId.get(r.id)! } : r)) };
}

/** Rings in the 3D view for lights measured from two or more spots (white) and from one (amber). */
export function measuredMarkers(result: SolveResult | null): { positions: Float32Array; colors: Float32Array } | null {
  if (!result?.pixels.length) return null;
  const positions = new Float32Array(result.pixels.length * 3), colors = new Float32Array(result.pixels.length * 3);
  result.pixels.forEach((p, i) => {
    positions.set(p.X, i * 3);
    colors.set(p.source === 'triangulated' ? [0.85, 0.95, 1] : [1, 0.72, 0.3], i * 3);
  });
  return { positions, colors };
}

/**
 * Ray casts against the house model (its visible parts, placed as in the 3D view), so a light seen
 * from one spot only can still get a position where its ray meets the house. Null until loaded or
 * when there's no model.
 */
export function useHouseRaycast(house: House | null, enabled: boolean): ((origin: Vec3, dir: Vec3) => Vec3 | null) | null {
  const [root, setRoot] = useState<THREE.Group | null>(null);
  const key = house ? JSON.stringify(house) : '';
  useEffect(() => {
    if (!enabled || !house) { setRoot(null); return; }
    const parts = house.parts.filter((p) => p.visible);
    if (!parts.length) { setRoot(null); return; }
    let cancelled = false;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const group = new THREE.Group();
    group.position.set(...house.position);
    group.rotation.y = (house.rotation * Math.PI) / 180;
    group.scale.setScalar(house.scale);
    Promise.all(parts.map(async (p) => {
      const gltf = await loader.loadAsync(`/api/house/parts/${encodeURIComponent(p.id)}/model?v=${encodeURIComponent(p.uploadedAt)}`);
      const g = new THREE.Group();
      g.position.set(...p.position);
      g.rotation.y = (p.rotation * Math.PI) / 180;
      g.scale.setScalar(p.scale);
      g.add(gltf.scene);
      group.add(g);
    })).then(() => {
      if (cancelled) return;
      group.updateMatrixWorld(true);
      setRoot(group);
    }, () => { if (!cancelled) setRoot(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return useMemo(() => {
    if (!root) return null;
    const ray = new THREE.Raycaster();
    return (origin: Vec3, dir: Vec3) => {
      ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...dir));
      ray.far = 200;
      const hit = ray.intersectObject(root, true)[0];
      return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
    };
  }, [root]);
}
