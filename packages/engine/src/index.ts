export * from './layout.js';
export * from './color.js';
export * from './effects.js';
export * from './scene.js';
export * from './paint.js';
export * from './playlist.js';
export * from './demo.js';

/** Palette names for the editor: WLED's 72 in the controller's order, then our own that don't clash by name. */
export { builtinPaletteStops, paletteStopsFor, PALETTE_NAMES, WLED_PALETTE_NAMES } from './wled/palettes.js';

/** Edited and saved palettes: gradient stops kept with a layer (params.paletteStops) or in the show state. */
export { checkPaletteStops, isPaletteStops, MAX_PALETTE_STOPS, type PaletteStop, type SavedPalette } from './wled/stops.js';

/** Palette colours for editor previews. */
export { paletteColors } from './wled/swatch.js';

/** Wall clock for effects that show the time or date (Scrolling Text's #TIME etc.). */
export { setWallClock } from './wled/effects/text.js';
