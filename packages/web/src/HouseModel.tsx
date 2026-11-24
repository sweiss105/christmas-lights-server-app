import { Suspense, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { House } from './api';

/**
 * The scanned house, toned down to a night-time look so the lights stand out. Each scan part sits
 * inside the house transform, so parts are first placed against each other, then the whole house
 * is lined up with the lights.
 */
export function HouseModel({ house, onPick }: { house: House; onPick?: (p: [number, number, number]) => void }) {
  const parts = house.parts.filter((p) => p.visible);
  if (!parts.length) return null;
  return (
    <group position={house.position} rotation-y={(house.rotation * Math.PI) / 180} scale={house.scale}
      onClick={onPick ? (e) => { if (e.delta > 6) return; e.stopPropagation(); onPick([e.point.x, Math.max(0, e.point.y), e.point.z]); } : undefined}>
      {parts.map((p) => (
        <group key={p.id} position={p.position} rotation-y={(p.rotation * Math.PI) / 180} scale={p.scale}>
          <Suspense fallback={null}>
            <Model url={`/api/house/parts/${encodeURIComponent(p.id)}/model?v=${encodeURIComponent(p.uploadedAt)}`} opacity={house.opacity} />
          </Suspense>
        </group>
      ))}
    </group>
  );
}

const NIGHT = 0.32; // how much of the daylight colour survives

/** One scan. Scans carry baked daylight textures, so materials become unlit ones that keep the texture but darken it. */
function Model({ url, opacity }: { url: string; opacity: number }) {
  // No Draco (its decoder would load from a CDN); meshopt compression is supported without one.
  const gltf = useGLTF(url, false, true);
  const scene = useMemo(() => {
    const root = gltf.scene.clone(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
      mesh.material = new THREE.MeshBasicMaterial({
        map: old?.map ?? null,
        color: old?.map ? new THREE.Color(NIGHT, NIGHT, NIGHT * 1.15) : new THREE.Color(0.09, 0.1, 0.13),
        vertexColors: !old?.map && !!mesh.geometry.getAttribute('color'),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: true,
      });
    });
    return root;
  }, [gltf]);

  useEffect(() => {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m && 'opacity' in m) { m.opacity = opacity; m.depthWrite = opacity > 0.95; m.needsUpdate = true; }
    });
  }, [scene, opacity]);

  useEffect(() => () => {
    scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; m?.dispose(); });
  }, [scene]);

  return <primitive object={scene} />;
}
