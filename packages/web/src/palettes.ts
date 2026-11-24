import { PALETTE_NAMES } from '@xmas/engine';

/**
 * Palette names offered in the editor. The engine owns the list (our palettes now; WLED's 72 are
 * being ported and will be added there), so the UI never hard-codes palettes.
 */
export function listPalettes(): string[] {
  return [...PALETTE_NAMES];
}
