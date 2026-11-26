import type { EditMode } from './useSceneEditor';

/**
 * The app's pages: Create (designing scenes), Control (running the porch), Setup (one-off things)
 * and Watch (a full-screen live view for a tablet or TV). Each has its own address, e.g. #/create.
 */
export type Page = 'create' | 'control' | 'setup' | 'watch';

/** Create's tools: Move shows the scene's layers; Select picks lights; Brush and Eraser paint. */
export type CreateTool = 'move' | 'select' | 'brush' | 'erase';
/** Setup's tools, each with its own panel. */
export type SetupTool = 'strings' | 'house' | 'map' | 'wled' | 'backups' | 'home';

export const SETUP_TOOLS: SetupTool[] = ['strings', 'house', 'map', 'wled', 'backups', 'home'];

export interface Route {
  page: Page;
  /** Setup's tool (the other pages keep their tool in the app, not the address). */
  setupTool: SetupTool;
  /** The camera mapping screen (filming) is open over Setup. */
  capture: boolean;
  /** Filming with a simulated camera (#map-demo), for trying it out without the porch. */
  demo: boolean;
}

/** The page the app opens on: Control, where nothing can be edited by accident. */
export const HOME: Route = { page: 'control', setupTool: 'strings', capture: false, demo: false };

/** Where an address points. Unknown addresses open Control; the old #map and #map-demo open the filming screen. */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (h === 'map' || h === 'map-demo') return { page: 'setup', setupTool: 'map', capture: true, demo: h === 'map-demo' };
  const [page, tool] = h.replace(/^\//, '').split('/');
  switch (page) {
    case 'create': return { ...HOME, page: 'create' };
    case 'watch': return { ...HOME, page: 'watch' };
    case 'setup': return { ...HOME, page: 'setup', setupTool: SETUP_TOOLS.includes(tool as SetupTool) ? tool as SetupTool : 'strings' };
    default: return HOME;
  }
}

/** The address of a route. */
export function routeHash(r: Route): string {
  if (r.capture) return r.demo ? '#map-demo' : '#map';
  if (r.page === 'setup') return r.setupTool === 'strings' ? '#/setup' : `#/setup/${r.setupTool}`;
  return `#/${r.page}`;
}

export type ModeTone = 'green' | 'blue' | 'red' | 'grey';

/**
 * The mode light at the top left: green on Control and Watch (running the show), blue while
 * creating in Blind (the porch doesn't change), red in Live (edits show on the porch), grey on
 * Setup. Its name is shown beside it, so the colour is never the only signal.
 */
export function modeLight(page: Page, mode: EditMode): { tone: ModeTone; label: string } {
  switch (page) {
    case 'create': return mode === 'live' ? { tone: 'red', label: 'Create · Live' } : { tone: 'blue', label: 'Create · Blind' };
    case 'setup': return { tone: 'grey', label: 'Setup' };
    case 'watch': return { tone: 'green', label: 'Watching' };
    default: return { tone: 'green', label: 'Control' };
  }
}

/** Create's keyboard shortcuts (as in Photoshop): V move, M select, B brush, E eraser. */
export function toolForKey(key: string): CreateTool | null {
  switch (key.toLowerCase()) {
    case 'v': return 'move';
    case 'm': return 'select';
    case 'b': return 'brush';
    case 'e': return 'erase';
    default: return null;
  }
}

/** True when a key press belongs to a text field, a menu or a dialog rather than to the app's shortcuts. */
export function typingTarget(t: { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'color', 'button'].includes((t.type ?? 'text').toLowerCase())) return true;
  return !!t.closest?.('[role="dialog"], [role="menu"], [role="listbox"]');
}
