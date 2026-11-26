/**
 * True in the public demo's build (`vite build --mode demo`). Vite replaces the mode with a constant,
 * so in the real build every `if (DEMO)` branch, and the demo code it loads, is left out.
 */
export const DEMO: boolean = import.meta.env.MODE === 'demo';

/** What the demo says when something would be stored. */
export const DEMO_REFUSAL = 'This is a demo: saving is turned off.';
/** The tooltip on buttons the demo turns off. */
export const DEMO_TIP = 'Saving is turned off in the demo';
