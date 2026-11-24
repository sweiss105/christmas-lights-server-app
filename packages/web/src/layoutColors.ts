import { hsv } from '@xmas/engine';

/** A distinct hue per run (golden-angle spacing), shared by the layout panel and the 3D preview. */
export function runHue(i: number): number { return (i * 0.381966 + 0.07) % 1; }

export function runColor(i: number, v: number): string {
  const [r, g, b] = hsv(runHue(i), 0.75, v);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
