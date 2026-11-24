/**
 * Light spill from the lights onto the house model (preview only). The lights are grouped once per
 * layout into a few dozen spatial clusters ("blobs"); each frame a blob's colour is the light its
 * pixels give off, and the house's clay material adds a soft, short-range wash from every blob.
 * Blobs are gathered, in order along the strings, into a few fixed-size groups with bounding
 * spheres, so the shader only walks the blobs of groups within reach of a surface, with fixed
 * loop counts (cheap on phone GPUs).
 */

/** Blob groups (each with a bounding sphere the shader tests first). */
export const GLOW_GROUPS = 8;
/** Blob slots per group. */
export const GLOW_GROUP_SIZE = 6;
/** Most blobs the house shader handles. Fixed, so the shader compiles once. */
export const GLOW_BLOBS = GLOW_GROUPS * GLOW_GROUP_SIZE;
/** Metres: past this a blob adds nothing. */
export const GLOW_RANGE = 1.6;
/** Where unused blob slots sit: out of reach of everything. */
const FAR = 1e4;

export interface GlowClusters {
  /** xyz per blob slot (GLOW_BLOBS * 3); group g owns slots g * GLOW_GROUP_SIZE onwards. Unused slots sit far away. */
  centers: Float32Array;
  /** Blob slot for each pixel. */
  assign: Int32Array;
  /** Pixels per blob slot. */
  counts: Int32Array;
  /** Blobs in use (at most GLOW_BLOBS). */
  used: number;
  /**
   * Per group (GLOW_GROUPS * 4): centre xyz and the squared distance within which a surface can
   * get light from one of its blobs (sphere radius + GLOW_RANGE, squared); -1 for an empty group.
   */
  groups: Float32Array;
}

/** Lloyd's k-means; seeds spread evenly along the point order. Deterministic. */
function kmeans(points: Float32Array, k: number, rounds: number): { centers: Float32Array; assign: Int32Array; used: number } {
  const n = Math.floor(points.length / 3);
  const used = Math.min(k, n);
  const centers = new Float32Array(used * 3);
  const assign = new Int32Array(n);
  for (let c = 0; c < used; c++) {
    const i = Math.min(n - 1, Math.floor(((c + 0.5) * n) / used));
    centers[c * 3] = points[i * 3]!; centers[c * 3 + 1] = points[i * 3 + 1]!; centers[c * 3 + 2] = points[i * 3 + 2]!;
  }
  const sums = new Float64Array(used * 3);
  const counts = new Int32Array(used);
  for (let r = 0; r < rounds && used; r++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const x = points[i * 3]!, y = points[i * 3 + 1]!, z = points[i * 3 + 2]!;
      let best = 0, bestD = Infinity;
      for (let c = 0; c < used; c++) {
        const dx = x - centers[c * 3]!, dy = y - centers[c * 3 + 1]!, dz = z - centers[c * 3 + 2]!;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (r === 0 || assign[i] !== best) changed = true;
      assign[i] = best;
    }
    if (!changed) break;
    sums.fill(0); counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i]!;
      counts[c] = counts[c]! + 1;
      sums[c * 3] = sums[c * 3]! + points[i * 3]!;
      sums[c * 3 + 1] = sums[c * 3 + 1]! + points[i * 3 + 1]!;
      sums[c * 3 + 2] = sums[c * 3 + 2]! + points[i * 3 + 2]!;
    }
    for (let c = 0; c < used; c++) {
      const m = counts[c]!;
      if (!m) continue; // keep an empty cluster where it was
      centers[c * 3] = sums[c * 3]! / m; centers[c * 3 + 1] = sums[c * 3 + 1]! / m; centers[c * 3 + 2] = sums[c * 3 + 2]! / m;
    }
  }
  return { centers, assign, used };
}

/**
 * Groups pixel positions (xyz per pixel, in string order) into at most GLOW_BLOBS spatial blobs,
 * then cuts the blobs, ordered along the strings, into GLOW_GROUPS runs of neighbours.
 */
export function clusterLights(positions: Float32Array, rounds = 10): GlowClusters {
  const n = Math.floor(positions.length / 3);
  const blobs = kmeans(positions, GLOW_BLOBS, rounds);
  const used = blobs.used;

  // Order blobs by where they fall along the strings (their pixels' mean index).
  const meanIndex = new Float64Array(used);
  const sizes = new Int32Array(used);
  for (let i = 0; i < n; i++) { const b = blobs.assign[i]!; meanIndex[b] = meanIndex[b]! + i; sizes[b] = sizes[b]! + 1; }
  const order = Array.from({ length: used }, (_, b) => b)
    .sort((a, b) => meanIndex[a]! / Math.max(1, sizes[a]!) - meanIndex[b]! / Math.max(1, sizes[b]!) || a - b);

  // Consecutive blobs share a group; each group's blobs fill its slots from the start.
  const per = Math.ceil(used / GLOW_GROUPS);
  const slotOf = new Int32Array(used);
  const centers = new Float32Array(GLOW_BLOBS * 3).fill(FAR);
  order.forEach((b, k) => {
    const slot = Math.floor(k / per) * GLOW_GROUP_SIZE + (k % per);
    slotOf[b] = slot;
    centers.set(blobs.centers.subarray(b * 3, b * 3 + 3), slot * 3);
  });
  const assign = new Int32Array(n);
  const counts = new Int32Array(GLOW_BLOBS);
  for (let i = 0; i < n; i++) {
    const slot = slotOf[blobs.assign[i]!]!;
    assign[i] = slot;
    counts[slot] = counts[slot]! + 1;
  }

  // Bounding sphere per group (around its blobs' mean), grown by the glow's reach.
  const groups = new Float32Array(GLOW_GROUPS * 4);
  for (let g = 0; g < GLOW_GROUPS; g++) {
    const first = g * GLOW_GROUP_SIZE, count = Math.max(0, Math.min(per, used - g * per));
    if (!count) { groups[g * 4 + 3] = -1; continue; }
    let cx = 0, cy = 0, cz = 0;
    for (let s = first; s < first + count; s++) { cx += centers[s * 3]!; cy += centers[s * 3 + 1]!; cz += centers[s * 3 + 2]!; }
    cx /= count; cy /= count; cz /= count;
    let r = 0;
    for (let s = first; s < first + count; s++) r = Math.max(r, Math.hypot(centers[s * 3]! - cx, centers[s * 3 + 1]! - cy, centers[s * 3 + 2]! - cz));
    groups[g * 4] = cx; groups[g * 4 + 1] = cy; groups[g * 4 + 2] = cz;
    groups[g * 4 + 3] = (r + GLOW_RANGE) ** 2;
  }
  return { centers, assign, counts, used, groups };
}

/**
 * Each blob's light this frame, written into `out` (rgb per blob, linear). `colors` holds the
 * pixels' screen colours (0..1, rgb per pixel, in the same order as the clustered positions). A
 * blob's light is the sum of its pixels' light, scaled so a blob of the average size at full white
 * gives 1: denser stretches of lights glow brighter. No allocation; O(pixels + blobs).
 */
export function glowColors(colors: Float32Array, clusters: GlowClusters, out: Float32Array): void {
  out.fill(0);
  const n = clusters.assign.length;
  if (!clusters.used) return;
  for (let i = 0; i < n; i++) {
    const c = clusters.assign[i]! * 3;
    // sRGB to linear (squared is close enough and cheap): dim pixels add little light.
    const r = colors[i * 3]!, g = colors[i * 3 + 1]!, b = colors[i * 3 + 2]!;
    out[c] = out[c]! + r * r; out[c + 1] = out[c + 1]! + g * g; out[c + 2] = out[c + 2]! + b * b;
  }
  const scale = clusters.used / n; // 1 / average pixels per blob
  for (let c = 0; c < out.length; c++) out[c] = out[c]! * scale;
}
