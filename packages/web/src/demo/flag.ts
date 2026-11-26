/**
 * True in the public demo's build (`vite build --mode demo`). Vite replaces the mode with a constant,
 * so in the real build every `if (DEMO)` branch, and the demo code it loads, is left out.
 */
export const DEMO: boolean = import.meta.env.MODE === 'demo';
