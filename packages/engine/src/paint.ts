/**
 * Paint: how strongly a layer shows on each light, 0..255 per global pixel index. A painted layer
 * only shows where it has been painted. Scenes store it as base64 with trailing zeros dropped, so a
 * lightly painted layer stays small and adding lights later doesn't change the text.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/** Longest paint text a scene may carry (about 150 000 lights). */
export const MAX_PAINT_LENGTH = 200_000;

export function encodePaint(weights: Uint8Array): string {
  let n = weights.length;
  while (n > 0 && weights[n - 1] === 0) n--;
  let out = '';
  for (let i = 0; i < n; i += 3) {
    const a = weights[i]!, b = i + 1 < n ? weights[i + 1]! : 0, c = i + 2 < n ? weights[i + 2]! : 0;
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < n ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=';
    out += i + 2 < n ? ALPHABET[c & 63]! : '=';
  }
  return out;
}

/**
 * Decode paint into `count` weights. Lights beyond the stored ones are unpainted, and stored ones
 * beyond `count` are ignored, so a scene survives its layout growing or shrinking. Throws on text
 * that isn't base64.
 */
export function decodePaint(text: string, count?: number): Uint8Array {
  if (typeof text !== 'string' || text.length % 4 !== 0 || text.length > MAX_PAINT_LENGTH) throw new Error('paint must be base64 text');
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const stored = (text.length / 4) * 3 - pad;
  const out = new Uint8Array(count ?? stored);
  const sextet = (k: number): number => {
    const ch = text.charCodeAt(k);
    const v = ch < 128 ? LOOKUP[ch]! : -1;
    if (v < 0) {
      if (ch === 61 && k >= text.length - pad) return 0; // '=' padding at the very end
      throw new Error('paint must be base64 text');
    }
    return v;
  };
  for (let i = 0, k = 0; k < text.length; i += 3, k += 4) {
    const a = sextet(k), b = sextet(k + 1), c = sextet(k + 2), d = sextet(k + 3);
    if (i < stored && i < out.length) out[i] = (a << 2) | (b >> 4);
    if (i + 1 < stored && i + 1 < out.length) out[i + 1] = ((b & 15) << 4) | (c >> 2);
    if (i + 2 < stored && i + 2 < out.length) out[i + 2] = ((c & 3) << 6) | d;
  }
  return out;
}
