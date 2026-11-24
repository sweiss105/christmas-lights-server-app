import type * as THREE from 'three';
import { GLOW_BLOBS, GLOW_GROUP_SIZE, GLOW_GROUPS, GLOW_RANGE } from './glow';

/** Shared by every clay material on the house; the preview updates them once a frame. */
export interface GlowUniforms {
  /** World xyz per blob. */
  uGlowPos: { value: Float32Array };
  /** Linear rgb per blob. */
  uGlowCol: { value: Float32Array };
  /** Per blob group: bounding sphere (centre xyz, squared reach). */
  uGlowGroup: { value: Float32Array };
  /** 0 turns the glow off (the shader skips its loop). */
  uGlowStrength: { value: number };
}

export function createGlowUniforms(): GlowUniforms {
  return {
    uGlowPos: { value: new Float32Array(GLOW_BLOBS * 3) },
    uGlowCol: { value: new Float32Array(GLOW_BLOBS * 3) },
    uGlowGroup: { value: new Float32Array(GLOW_GROUPS * 4).fill(-1) },
    uGlowStrength: { value: 0 },
  };
}

const f = (v: number) => v.toFixed(4);

// Distance falloff: an inverse-square-like curve (half strength at 0.5 m) windowed to zero at
// GLOW_RANGE, and a wrapped Lambert term so surfaces turned slightly away still catch some light.
const FRAGMENT_PARS = /* glsl */ `
uniform vec3 uGlowPos[${GLOW_BLOBS}];
uniform vec3 uGlowCol[${GLOW_BLOBS}];
uniform vec4 uGlowGroup[${GLOW_GROUPS}];
uniform float uGlowStrength;
varying vec3 vGlowWorld;
`;

const FRAGMENT_GLOW = /* glsl */ `
if (uGlowStrength > 0.0) {
  vec3 glowN = inverseTransformDirection(normal, viewMatrix);
  vec3 glow = vec3(0.0);
  for (int g = 0; g < ${GLOW_GROUPS}; g++) {
    vec4 s = uGlowGroup[g];
    vec3 dg = s.xyz - vGlowWorld;
    if (dot(dg, dg) > s.w) continue; // no blob of this group reaches here
    for (int j = 0; j < ${GLOW_GROUP_SIZE}; j++) {
      int i = g * ${GLOW_GROUP_SIZE} + j;
      vec3 d = uGlowPos[i] - vGlowWorld;
      float d2 = dot(d, d);
      if (d2 >= ${f(GLOW_RANGE * GLOW_RANGE)}) continue;
      float win = 1.0 - d2 * ${f(1 / (GLOW_RANGE * GLOW_RANGE))};
      float fall = win * win / (1.0 + d2 * 4.0);
      float facing = dot(glowN, d * inversesqrt(max(d2, 1e-4)));
      glow += uGlowCol[i] * (fall * clamp((facing + 0.35) / 1.35, 0.0, 1.0));
    }
  }
  outgoingLight += diffuseColor.rgb * glow * uGlowStrength;
}
`;

/**
 * Adds the lights' spill to a lit (MeshStandardMaterial) house material, in world space so it
 * follows the house and part transforms. Not for unlit photo scans: their light is baked in.
 */
export function addGlow(material: THREE.MeshStandardMaterial, uniforms: GlowUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGlowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <opaque_fragment>', `${FRAGMENT_GLOW}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'xmas-glow';
}
