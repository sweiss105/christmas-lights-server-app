import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, Grid, Line } from '@react-three/drei';
import * as THREE from 'three';
import { buildLayout, Engine, hsv, type Layout, type LayoutConfig, type SceneConfig, type Vec3 } from '@xmas/engine';
import { runHue } from './layoutColors';
import type { ServerClock } from './clock';
import type { House } from './api';
import { HouseModel } from './HouseModel';
import { fitPoints, viewPoints, VIEW_ANGLES, type Box, type HouseBounds, type View } from './cameraFit';
import { clusterLights, glowColors } from './glow';
import { createGlowUniforms, type GlowUniforms } from './glowMaterial';

export type CameraPreset = View;

interface PreviewProps {
  layout: LayoutConfig;
  scene: SceneConfig | null;
  clock: ServerClock;
  preset: { name: CameraPreset; nonce: number };
  /** Pixels covered by side panels; the view is centred in the space between them. */
  leftInset?: number;
  rightInset?: number;
  /** Pixels covered at the top (the top bar). */
  topInset?: number;
  /** Pixels covered at the bottom (the phone's bottom sheet, the view bar). */
  bottomInset?: number;
  house?: House | null;
  /** Layout mode: diagnostic run colours, point handles and drawing. */
  layoutEdit?: LayoutEdit | null;
  /** Select mode: highlight these lights. */
  selection?: Set<number> | null;
  /** Receives a function that projects every light to canvas pixels (x, y pairs; NaN if not visible). */
  onProjector?: (project: (() => Float32Array) | null) => void;
  /** Show each run in its own colour (as in Layout mode) instead of the scene. */
  diagnostic?: boolean;
  /** Rings at these positions (xyz) in these colours (rgb 0..1), e.g. measured lights. */
  markers?: { positions: Float32Array; colors: Float32Array } | null;
}

export interface LayoutEdit {
  selected: string | null;
  drawing: boolean;
  onAddPoint: (p: Vec3) => void;
  /** `done` is true when a drag ends. */
  onMovePoint: (index: number, p: Vec3, done: boolean) => void;
}

const BACKGROUND = '#06080d';
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The 3D preview: the porch's pixels, rendered in the browser by the same engine as the porch. */
export function Preview({ layout, scene, clock, preset, leftInset = 0, rightInset = 0, topInset = 0, bottomInset = 0, house, layoutEdit, selection, onProjector, diagnostic, markers }: PreviewProps) {
  const built = useMemo(() => buildLayout(layout), [layout]);
  const diag = useMemo(() => (layoutEdit ? { config: layout, selected: layoutEdit.selected } : diagnostic ? { config: layout, selected: null } : null), [layoutEdit, diagnostic, layout]);
  const glow = useMemo(createGlowUniforms, []);
  // The lights' spill on the house: only on a shown house, and not with diagnostic colours (layout mode, mapping review).
  const showHouse = !!house?.parts.some((p) => p.visible);
  const glowStrength = showHouse && !diag ? (house?.glow ?? 1) : 0;
  const [houseBounds, setHouseBounds] = useState<HouseBounds | null>(null);
  const insets = useMemo(() => ({ left: leftInset, right: rightInset, top: topInset, bottom: bottomInset }), [leftInset, rightInset, topInset, bottomInset]);
  return (
    <Canvas
      className="preview-canvas"
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.05, far: 400, position: [0, 3, 12] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => gl.setClearColor(BACKGROUND)}
    >
      {/* Fades the endless floor into the night. A house brings its own ground and is often seen from further back, so its fog follows the camera. */}
      <fog attach="fog" args={[BACKGROUND, 18, 60]} />
      <FogFollow enabled={showHouse} />
      {/* A house model brings its own ground (lawns, slopes, steps below porch level), which a flat floor at 0 m would hide. */}
      {!showHouse && <Ground layout={built} />}
      {house && <HouseModel house={house} glow={glow} onBounds={setHouseBounds} onPick={layoutEdit?.drawing ? layoutEdit.onAddPoint : undefined} />}
      <Wires layout={layout} />
      <Pixels layout={built} scene={scene} clock={clock} glow={glow} glowStrength={glowStrength} diagnostic={diag} />
      {markers && <Markers markers={markers} />}
      {layoutEdit && <LayoutTools layout={layout} edit={layoutEdit} />}
      {selection && <SelectionHighlight layout={built} selection={selection} />}
      {onProjector && <Projector layout={built} onProjector={onProjector} />}
      <Camera layout={built} preset={preset} insets={insets} house={showHouse ? houseBounds : null} />
      <ViewOffset {...insets} />
    </Canvas>
  );
}

/**
 * Keeps the fog behind what the camera looks at: with a house, the whole-house view on a narrow
 * screen can stand 50 m back, where the fixed fog would hide the house altogether.
 */
function FogFollow({ enabled }: { enabled: boolean }) {
  const scene = useThree((s) => s.scene);
  const controls = useThree((s) => s.controls) as unknown as CameraControls | null;
  useFrame(() => {
    const fog = scene.fog as THREE.Fog | null;
    if (!fog) return;
    const d = enabled && controls ? controls.distance : 0;
    fog.near = Math.max(18, d + 10);
    fog.far = Math.max(60, d + 60);
  });
  return null;
}

/** Shifts the projection so the scene centres in the area between the side panels. */
function ViewOffset({ left, right, top, bottom }: Insets) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    // dy > 0 moves the scene up, into the area above the phone's sheet or the view bar.
    const { dx, dy } = visibleArea({ left, right, top, bottom }, size.width, size.height);
    if (dx !== 0 || dy !== 0) camera.setViewOffset(size.width, size.height, -dx, dy, size.width, size.height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, [camera, size, left, right, top, bottom]);
  return null;
}

function Ground({ layout }: { layout: Layout }) {
  const c = center(layout);
  return (
    <group position={[c[0], 0, c[2]]}>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.002}>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial color="#0a0d14" />
      </mesh>
      <Grid
        infiniteGrid
        cellSize={0.5}
        sectionSize={2}
        cellThickness={0.5}
        sectionThickness={0.8}
        cellColor="#141a26"
        sectionColor="#1d2534"
        fadeDistance={34}
        fadeStrength={1.6}
      />
    </group>
  );
}

/** The runs' paths, drawn faintly so the strings read as physical objects even when dark. */
function Wires({ layout }: { layout: LayoutConfig }) {
  return (
    <group>
      {layout.runs.map((r) => {
        // Measured runs follow their lights; drawn ones their path.
        const pts = r.positions && r.positions.length > 1 ? r.positions : r.points;
        return pts && pts.length > 1 ? <Line key={r.id} points={pts as Vec3[]} color="#273041" lineWidth={1.2} transparent opacity={0.9} /> : null;
      })}
    </group>
  );
}

const vertexShader = /* glsl */ `
  attribute vec3 color;
  uniform float uScale;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(2.0, uSize * uScale / -mv.z);
  }
`;

// A bright core plus a soft halo, added on top of the scene, so lit pixels glow and unlit ones
// still show as faint bulbs on the string.
const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.42, 0.0, d);
    float halo = exp(-d * d * 5.0) * 0.55;
    vec3 lit = vColor * (core * 1.35 + halo);
    vec3 bulb = vec3(0.055, 0.06, 0.075) * smoothstep(0.3, 0.0, d);
    gl_FragColor = vec4(lit + bulb, 1.0);
  }
`;

/** Static colours for layout mode: each run its own hue, dim at its first pixel, bright at its last. */
function diagnosticColors(layout: Layout, config: LayoutConfig, selected: string | null, index: Int32Array, out: Float32Array) {
  const pos = new Map<number, number>();
  index.forEach((g, j) => pos.set(g, j));
  config.runs.forEach((r, i) => {
    const base = layout.controllerOffset.get(r.controller);
    if (base === undefined) return;
    const dim = selected && selected !== r.id ? 0.35 : 1;
    for (let k = 0; k < r.count; k++) {
      const j = pos.get(base + r.start + k);
      if (j === undefined) continue;
      const v = (0.18 + 0.82 * (r.count > 1 ? k / (r.count - 1) : 1)) * dim;
      const [cr, cg, cb] = hsv(runHue(i), 0.75, v);
      out[j * 3] = cr; out[j * 3 + 1] = cg; out[j * 3 + 2] = cb;
    }
  });
}

/** How bright the spill is at strength 1 (the house setting), tuned by eye on a night view. */
const GLOW_GAIN = 1.07; // two-thirds of the first tuning (1.6), at the owner's request

function Pixels({ layout, scene, clock, glow, glowStrength, diagnostic }: {
  layout: Layout; scene: SceneConfig | null; clock: ServerClock; glow: GlowUniforms; glowStrength: number;
  diagnostic: { config: LayoutConfig; selected: string | null } | null;
}) {
  const { geometry, colors, index, clusters } = useMemo(() => {
    const idx: number[] = [];
    for (let i = 0; i < layout.count; i++) if (layout.mapped[i] && !Number.isNaN(layout.positions[i * 3]!)) idx.push(i);
    const pos = new Float32Array(idx.length * 3);
    idx.forEach((i, j) => pos.set(layout.positions.subarray(i * 3, i * 3 + 3), j * 3));
    const col = new Float32Array(idx.length * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.computeBoundingSphere();
    return { geometry: g, colors: col, index: Int32Array.from(idx), clusters: clusterLights(pos) };
  }, [layout]);
  useEffect(() => {
    glow.uGlowPos.value.set(clusters.centers);
    glow.uGlowGroup.value.set(clusters.groups);
  }, [glow, clusters]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Preview at the scene's designed colours: full brightness, no output gamma (the screen applies its own).
  const engine = useMemo(() => { const e = new Engine(layout); e.setOutput({ brightness: 1, gamma: 1 }); return e; }, [layout]);
  useEffect(() => {
    try { engine.setScene(scene ?? { name: 'Blackout', layers: [] }); } catch { engine.setScene({ name: 'Blackout', layers: [] }); }
  }, [engine, scene]);

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { uScale: { value: 800 }, uSize: { value: 0.14 } },
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }), []);
  useEffect(() => () => material.dispose(), [material]);

  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  useEffect(() => {
    if (!diagnostic) return;
    diagnosticColors(layout, diagnostic.config, diagnostic.selected, index, colors);
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }, [diagnostic, layout, index, colors, geometry]);

  useFrame(({ camera }) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
    material.uniforms.uScale!.value = (size.height * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    glow.uGlowStrength.value = diagnostic ? 0 : glowStrength * GLOW_GAIN;
    if (diagnostic) return;
    const frame = engine.render(clock.now());
    for (let j = 0; j < index.length; j++) {
      const i = index[j]! * 3, o = j * 3;
      colors[o] = frame[i]! / 255; colors[o + 1] = frame[i + 1]! / 255; colors[o + 2] = frame[i + 2]! / 255;
    }
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    if (glowStrength > 0) glowColors(colors, clusters, glow.uGlowCol.value); // O(pixels), no allocation
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

function center(layout: Layout): Vec3 {
  const { min, max } = layout.bounds;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** Box around every placed pixel, with a little height so a flat run still frames well. */
function layoutBox(layout: Layout): Box {
  const { min, max } = layout.bounds;
  if (!(max[0] >= min[0] && max[1] >= min[1] && max[2] >= min[2])) return { min: [-2, 0, -1], max: [2, 2, 1] };
  return { min: [min[0], Math.min(min[1], 0), min[2]], max: [max[0], max[1], max[2]] };
}

/** Screen edges covered by panels and bars, in pixels; the view is fitted and centred in the rest. */
export interface Insets { left: number; right: number; top: number; bottom: number }




/**
 * The screen area the panels leave free, in pixels, and how far its centre is from the screen's.
 * Panels that would leave almost nothing are ignored, so a tiny window still shows the scene.
 */
function visibleArea(insets: Insets, width: number, height: number) {
  const sides = insets.left + insets.right < width * 0.8;
  const ends = insets.top + insets.bottom < height * 0.8;
  return {
    w: sides ? width - insets.left - insets.right : width,
    h: ends ? height - insets.top - insets.bottom : height,
    dx: sides ? (insets.left - insets.right) / 2 : 0,
    dy: ends ? (insets.bottom - insets.top) / 2 : 0,
  };
}

function Camera({ layout, preset, insets, house }: { layout: Layout; preset: { name: CameraPreset; nonce: number }; insets: Insets; house: HouseBounds | null }) {
  const ref = useRef<CameraControls>(null);
  const first = useRef(true);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  // The house's bounds are read whenever a view is chosen, but only a new set of loaded parts
  // re-frames by itself: moving the model in the House panel shouldn't keep yanking the view around.
  const houseRef = useRef<HouseBounds | null>(null);
  houseRef.current = house;
  const houseKey = house?.key ?? '';
  const { left, right, top, bottom } = insets;
  useEffect(() => {
    const controls = ref.current;
    if (!controls || width <= 0 || height <= 0) return;
    const v = VIEW_ANGLES[preset.name];
    const points = viewPoints(preset.name, layoutBox(layout), houseRef.current);
    const margin = houseRef.current ? v.houseMargin : v.margin;
    // Fit into the part of the screen the panels leave free (ViewOffset centres the view there).
    const area = visibleArea({ left, right, top, bottom }, width, height);
    const tanY = Math.tan(((camera.fov || 40) * Math.PI) / 360);
    const tanX = tanY * (width / height);
    const fit = fitPoints(points, v.azimuth, v.polar, tanX * (area.w / width) * (1 - margin), tanY * (area.h / height) * (1 - margin));
    // Glide between views. Interruptible: grabbing the view mid-move takes over at once.
    const animate = !first.current && !reducedMotion();
    void controls.setLookAt(...fit.position, ...fit.target, animate);
    first.current = false;
  }, [layout, preset, houseKey, left, right, top, bottom, width, height, camera]);
  return (
    <CameraControls
      ref={ref}
      makeDefault
      smoothTime={0.35}
      minDistance={0.8}
      maxDistance={80}
      maxPolarAngle={Math.PI / 2 - 0.02}
    />
  );
}

// ---- layout mode: point handles and drawing --------------------------------------------------

/** Handles on the selected run's points (drag to move) and, while drawing, a surface to tap on. */
function LayoutTools({ layout, edit }: { layout: LayoutConfig; edit: LayoutEdit }) {
  const run = layout.runs.find((r) => r.id === edit.selected);
  // A run placed by camera mapping has no path to drag: its lights sit at their measured positions.
  const points = run?.positions?.length ? [] : run?.points ?? [];
  const last = points.at(-1) ?? [0, 0, 0];
  return (
    <group>
      {points.map((p, i) => <Handle key={i} p={p as Vec3} kind={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'mid'} onMove={(q, done) => edit.onMovePoint(i, q, done)} />)}
      {edit.drawing && <DrawSurface z={last[2]} onAdd={edit.onAddPoint} />}
    </group>
  );
}

const HANDLE_COLORS = { start: '#3ddc84', mid: '#ffffff', end: '#ff6b5e' };

function Handle({ p, kind, onMove }: { p: Vec3; kind: 'start' | 'mid' | 'end'; onMove: (p: Vec3, done: boolean) => void }) {
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const drag = useRef<{ plane: THREE.Plane; offset: THREE.Vector3 } | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <mesh
      position={p}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
      onPointerOut={() => setHover(false)}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        // Drag in the plane through the point that faces the camera.
        const normal = new THREE.Vector3();
        e.camera.getWorldDirection(normal);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...p));
        const hit = new THREE.Vector3();
        e.ray.intersectPlane(plane, hit);
        drag.current = { plane, offset: new THREE.Vector3(...p).sub(hit) };
        if (controls) controls.enabled = false;
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        e.stopPropagation();
        const hit = new THREE.Vector3();
        if (!e.ray.intersectPlane(drag.current.plane, hit)) return;
        hit.add(drag.current.offset);
        onMove([hit.x, hit.y, hit.z], false); // below 0 is fine: house models can slope down to the street
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        e.stopPropagation();
        drag.current = null;
        if (controls) controls.enabled = true;
        onMove(p, true);
      }}
    >
      <sphereGeometry args={[kind === 'mid' ? 0.07 : 0.1, 16, 12]} />
      <meshBasicMaterial color={HANDLE_COLORS[kind]} transparent opacity={hover ? 1 : 0.85} depthTest={false} />
    </mesh>
  );
}

/** While drawing: a faint vertical plane in line with the run's last point, plus the ground, to tap on. */
function DrawSurface({ z, onAdd }: { z: number; onAdd: (p: Vec3) => void }) {
  const add = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 6) return; // that was an orbit drag, not a tap
    e.stopPropagation();
    onAdd([e.point.x, Math.max(0, e.point.y), e.point.z]);
  };
  return (
    <group>
      <mesh position={[0, 10, z]} onClick={add}>
        <planeGeometry args={[200, 20]} />
        <meshBasicMaterial color="#7aa2ff" transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.001} onClick={add}>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ---- select mode ------------------------------------------------------------------------------

/** Hands the app a function that projects every light into canvas pixels for the current view. */
function Projector({ layout, onProjector }: { layout: Layout; onProjector: (p: (() => Float32Array) | null) => void }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    const v = new THREE.Vector3();
    onProjector(() => {
      camera.updateMatrixWorld();
      const out = new Float32Array(layout.count * 2).fill(NaN);
      for (let i = 0; i < layout.count; i++) {
        if (!layout.mapped[i]) continue;
        v.set(layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!).project(camera);
        if (v.z > 1 || v.z < -1) continue; // behind the camera or past the far plane
        out[i * 2] = ((v.x + 1) / 2) * size.width;
        out[i * 2 + 1] = ((1 - v.y) / 2) * size.height;
      }
      return out;
    });
    return () => onProjector(null);
  }, [camera, size, layout, onProjector]);
  return null;
}

/** Coloured rings, e.g. lights measured by camera mapping. */
function Markers({ markers }: { markers: { positions: Float32Array; colors: Float32Array } }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(markers.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(markers.colors, 3));
    return g;
  }, [markers]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 } },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(6.0, 0.09 * uScale / -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float ring = smoothstep(0.55, 0.68, d) * (1.0 - smoothstep(0.85, 1.0, d));
        if (ring < 0.01) discard;
        gl_FragColor = vec4(vColor * ring, ring);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useFrame(({ camera }) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
    material.uniforms.uScale!.value = (size.height * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
  });
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={11} />;
}

/** A white ring around each selected light. */
function SelectionHighlight({ layout, selection }: { layout: Layout; selection: Set<number> }) {
  const geometry = useMemo(() => {
    const pos: number[] = [];
    for (const i of selection) if (layout.mapped[i]) pos.push(layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    return g;
  }, [layout, selection]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 } },
    vertexShader: /* glsl */ `
      uniform float uScale;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(7.0, 0.26 * uScale / -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float ring = smoothstep(0.62, 0.72, d) * (1.0 - smoothstep(0.86, 1.0, d));
        if (ring < 0.01) discard;
        gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * ring, ring);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
  }), []);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useFrame(({ camera }) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
    material.uniforms.uScale!.value = (size.height * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
  });
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />;
}
