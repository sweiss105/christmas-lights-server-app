import { Suspense, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { House } from './api';
import { addGlow, type GlowUniforms } from './glowMaterial';

/**
 * The scanned house, toned down to a night-time look so the lights stand out. Each scan part sits
 * inside the house transform, so parts are first placed against each other, then the whole house
 * is lined up with the lights.
 */
export function HouseModel({ house, onPick, glow }: { house: House; onPick?: (p: [number, number, number]) => void; glow?: GlowUniforms }) {
  const parts = house.parts.filter((p) => p.visible);
  if (!parts.length) return null;
  return (
    <group position={house.position} rotation-y={(house.rotation * Math.PI) / 180} scale={house.scale}
      onClick={onPick ? (e) => { if (e.delta > 6) return; e.stopPropagation(); onPick([e.point.x, e.point.y, e.point.z]); } : undefined}>
      {/* Light for clay-look models (scans use unlit materials and ignore it): soft sky light plus a low moon from front left. */}
      <hemisphereLight args={[0xb8c4e0, 0x1a1712, 0.45]} />
      <directionalLight position={[-6, 9, 8]} intensity={0.65} color={0xe8ecf8} />
      <directionalLight position={[7, 4, 5]} intensity={0.18} color={0xffe2c0} />
      {parts.map((p) => (
        <group key={p.id} position={p.position} rotation-y={(p.rotation * Math.PI) / 180} scale={p.scale}>
          <Suspense fallback={null}>
            <Model url={`/api/house/parts/${encodeURIComponent(p.id)}/model?v=${encodeURIComponent(p.uploadedAt)}`} opacity={house.opacity} glow={glow} />
          </Suspense>
        </group>
      ))}
    </group>
  );
}

const NIGHT = 0.32; // how much of the daylight colour survives
const CLAY = new THREE.Color(0.5, 0.48, 0.45); // warm grey
const CLAY_TINT = 0.3; // how much of a part's own colour shows through the clay
const EDGE_MAX_TRIS = 3000; // outline only simple, built shapes; leave bushes and ground smooth

/**
 * One model. Photo scans carry baked daylight textures, so their materials become unlit ones that
 * keep the texture but darken it. Models without textures (built from parts) get a matte, lit clay
 * look, slightly tinted by each part's colour, with faint outlines on hard edges, so walls, roof,
 * railings and steps read as separate shapes, and catches the coloured spill of nearby lights.
 */
function Model({ url, opacity, glow }: { url: string; opacity: number; glow?: GlowUniforms }) {
  // No Draco (its decoder would load from a CDN); meshopt compression is supported without one.
  const gltf = useGLTF(url, false, true);
  const scene = useMemo(() => {
    const root = gltf.scene.clone(true);
    const edges: [THREE.Mesh, THREE.LineSegments][] = []; // added after the walk, which mustn't visit them
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
      if (old?.map) {
        mesh.material = new THREE.MeshBasicMaterial({
          map: old.map, color: new THREE.Color(NIGHT, NIGHT, NIGHT * 1.15), transparent: true, side: THREE.DoubleSide, depthWrite: true,
        });
        return;
      }
      const tint = old?.color ? old.color.clone() : CLAY.clone();
      mesh.material = new THREE.MeshStandardMaterial({
        color: CLAY.clone().lerp(tint, CLAY_TINT),
        vertexColors: !!mesh.geometry.getAttribute('color'),
        roughness: 1, metalness: 0,
        flatShading: !mesh.geometry.getAttribute('normal'), // built models often ship without normals
        transparent: true, side: THREE.DoubleSide,
      });
      if (glow) addGlow(mesh.material as THREE.MeshStandardMaterial, glow); // the lights' spill (not on scans: their light is baked in)
      const tris = (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
      if (tris <= EDGE_MAX_TRIS) {
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30),
          new THREE.LineBasicMaterial({ color: 0x0b0c10, transparent: true, opacity: 0.45 }));
        line.userData.baseOpacity = 0.45;
        line.raycast = () => {}; // clicks (placing points) land on the surfaces, not the outlines
        edges.push([mesh, line]);
      }
    });
    for (const [mesh, line] of edges) mesh.add(line);
    return root;
  }, [gltf, glow]);

  useEffect(() => {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m) return;
      const base = (o.userData.baseOpacity as number | undefined) ?? 1;
      m.opacity = opacity * base;
      // Lit (clay) surfaces keep writing depth so overlapping parts don't show through each other.
      if (!(o as THREE.LineSegments).isLineSegments) m.depthWrite = opacity > 0.95 || m instanceof THREE.MeshStandardMaterial;
      m.needsUpdate = true;
    });
  }, [scene, opacity]);

  useEffect(() => () => {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose();
      if ((o as THREE.LineSegments).isLineSegments) (o as THREE.LineSegments).geometry.dispose();
    });
  }, [scene]);

  return <primitive object={scene} />;
}
