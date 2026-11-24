import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { CameraControls, Grid, Line } from '@react-three/drei';
import * as THREE from 'three';
import { buildLayout, Engine, type Layout, type LayoutConfig, type SceneConfig, type Vec3 } from '@xmas/engine';
import type { ServerClock } from './clock';

export type CameraPreset = 'front' | 'close' | 'angle' | 'top';

interface PreviewProps {
  layout: LayoutConfig;
  scene: SceneConfig | null;
  clock: ServerClock;
  preset: { name: CameraPreset; nonce: number };
  /** Pixels covered by side panels; the view is centred in the space between them. */
  leftInset?: number;
  rightInset?: number;
}

const BACKGROUND = '#06080d';
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The 3D preview: the porch's pixels, rendered in the browser by the same engine as the porch. */
export function Preview({ layout, scene, clock, preset, leftInset = 0, rightInset = 0 }: PreviewProps) {
  const built = useMemo(() => buildLayout(layout), [layout]);
  return (
    <Canvas
      className="preview-canvas"
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.05, far: 400, position: [0, 3, 12] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => gl.setClearColor(BACKGROUND)}
    >
      <fog attach="fog" args={[BACKGROUND, 18, 60]} />
      <Ground layout={built} />
      <Wires layout={layout} />
      <Pixels layout={built} scene={scene} clock={clock} />
      <Camera layout={built} preset={preset} hidden={leftInset + rightInset} />
      <ViewOffset left={leftInset} right={rightInset} />
    </Canvas>
  );
}

/** Shifts the projection so the scene centres in the area between the side panels. */
function ViewOffset({ left, right }: { left: number; right: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const shift = (left - right) / 2;
    if (shift !== 0 && left + right < size.width * 0.8) camera.setViewOffset(size.width, size.height, -shift, 0, size.width, size.height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, [camera, size, left, right]);
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
      {layout.runs.filter((r) => (r.points?.length ?? 0) > 1).map((r) => (
        <Line key={r.id} points={r.points as Vec3[]} color="#273041" lineWidth={1.2} transparent opacity={0.9} />
      ))}
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

function Pixels({ layout, scene, clock }: { layout: Layout; scene: SceneConfig | null; clock: ServerClock }) {
  const { geometry, colors, index } = useMemo(() => {
    const idx: number[] = [];
    for (let i = 0; i < layout.count; i++) if (layout.mapped[i] && !Number.isNaN(layout.positions[i * 3]!)) idx.push(i);
    const pos = new Float32Array(idx.length * 3);
    idx.forEach((i, j) => pos.set(layout.positions.subarray(i * 3, i * 3 + 3), j * 3));
    const col = new Float32Array(idx.length * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.computeBoundingSphere();
    return { geometry: g, colors: col, index: Int32Array.from(idx) };
  }, [layout]);
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

  useFrame(({ camera }) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
    material.uniforms.uScale!.value = (size.height * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    const frame = engine.render(clock.now());
    for (let j = 0; j < index.length; j++) {
      const i = index[j]! * 3, o = j * 3;
      colors[o] = frame[i]! / 255; colors[o + 1] = frame[i + 1]! / 255; colors[o + 2] = frame[i + 2]! / 255;
    }
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

function center(layout: Layout): Vec3 {
  const { min, max } = layout.bounds;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** Viewing angle for each preset (radians): azimuth around the vertical axis, polar from straight up. */
const PRESETS: Record<CameraPreset, { azimuth: number; polar: number; padding: number }> = {
  front: { azimuth: 0, polar: 1.3, padding: 0.12 },
  close: { azimuth: 0, polar: 1.42, padding: 0 },
  angle: { azimuth: -0.62, polar: 1.12, padding: 0.1 },
  top: { azimuth: 0, polar: 0.02, padding: 0.12 },
};

/** Box around every placed pixel, with a little height so a flat run still frames well. */
function layoutBox(layout: Layout): THREE.Box3 {
  const { min, max } = layout.bounds;
  const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 2, 1));
  box.min.y = Math.min(box.min.y, 0);
  return box;
}

function Camera({ layout, preset, hidden: hiddenPx }: { layout: Layout; preset: { name: CameraPreset; nonce: number }; hidden: number }) {
  const ref = useRef<CameraControls>(null);
  const first = useRef(true);
  const width = useThree((s) => s.size.width);
  useEffect(() => {
    const controls = ref.current;
    if (!controls) return;
    const p = PRESETS[preset.name];
    const box = layoutBox(layout);
    const size = box.getSize(new THREE.Vector3());
    const pad = Math.max(size.x, size.y, 1) * p.padding;
    // Side panels hide part of the width, so fit as if the view were that much narrower.
    const hidden = width > 0 ? Math.min(0.7, hiddenPx / width) : 0;
    const side = pad + (size.x * hidden) / (2 * (1 - hidden));
    // Glide between presets. Interruptible: grabbing the view mid-move takes over at once.
    const animate = !first.current && !reducedMotion();
    // fitToBox snaps the view to the nearest axis, so fit first (sets distance and target), then turn
    // to the preset's angle, which keeps that distance.
    void controls.fitToBox(box, animate, { paddingLeft: side, paddingRight: side, paddingTop: pad, paddingBottom: pad });
    void controls.rotateTo(p.azimuth, p.polar, animate);
    first.current = false;
  }, [layout, preset, hiddenPx, width]);
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
