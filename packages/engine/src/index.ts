export * from './layout.js';
export * from './color.js';
export * from './effects.js';
export * from './scene.js';
export * from './paint.js';

/** Palette names for the editor: WLED's 72 in the controller's order, then our own that don't clash by name. */
export { PALETTE_NAMES, WLED_PALETTE_NAMES } from './wled/palettes.js';

/** Palette colours for editor previews. */
export { paletteColors } from './wled/swatch.js';

/** Wall clock for effects that show the time or date (Scrolling Text's #TIME etc.). */
export { setWallClock } from './wled/effects/text.js';
