import { describe, expect, it } from 'vitest';
import { HOME, modeLight, parseHash, routeHash, toolForKey, typingTarget } from '../src/routes.js';
import { filterScenes } from '../src/chrome.js';

describe('page addresses', () => {
  it('opens on Control, also for an empty or unknown address', () => {
    expect(parseHash('')).toEqual(HOME);
    expect(parseHash('#')).toEqual(HOME);
    expect(parseHash('#/nowhere')).toEqual(HOME);
    expect(HOME.page).toBe('control');
  });

  it('reads each page and Setup tool', () => {
    expect(parseHash('#/create').page).toBe('create');
    expect(parseHash('#/control').page).toBe('control');
    expect(parseHash('#/watch').page).toBe('watch');
    expect(parseHash('#/setup')).toMatchObject({ page: 'setup', setupTool: 'strings' });
    expect(parseHash('#/setup/house')).toMatchObject({ page: 'setup', setupTool: 'house' });
    expect(parseHash('#/setup/bogus')).toMatchObject({ page: 'setup', setupTool: 'strings' });
  });

  it('keeps the old #map and #map-demo addresses: the filming screen over Setup', () => {
    expect(parseHash('#map')).toEqual({ page: 'setup', setupTool: 'map', capture: true, demo: false });
    expect(parseHash('#map-demo')).toEqual({ page: 'setup', setupTool: 'map', capture: true, demo: true });
  });

  it('writes addresses that read back the same', () => {
    for (const h of ['#/create', '#/control', '#/watch', '#/setup', '#/setup/map', '#/setup/home', '#map', '#map-demo']) {
      expect(routeHash(parseHash(h))).toBe(h);
    }
  });
});

describe('mode light', () => {
  it('is green on Control, blue in Blind, red in Live and grey on Setup, always with a name', () => {
    expect(modeLight('control', 'live')).toEqual({ tone: 'green', label: 'Control' });
    expect(modeLight('create', 'blind')).toEqual({ tone: 'blue', label: 'Create · Blind' });
    expect(modeLight('create', 'live')).toEqual({ tone: 'red', label: 'Create · Live' });
    expect(modeLight('setup', 'live')).toEqual({ tone: 'grey', label: 'Setup' });
    expect(modeLight('watch', 'blind').tone).toBe('green');
  });
});

describe('tool shortcuts', () => {
  it('maps V, M, B and E to the tools, either case', () => {
    expect(['v', 'M', 'b', 'E', 'x'].map(toolForKey)).toEqual(['move', 'select', 'brush', 'erase', null]);
  });

  it('leaves keys alone while typing', () => {
    expect(typingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(typingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(typingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(typingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(typingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(typingTarget({ tagName: 'DIV', closest: (s: string) => (s.includes('dialog') ? {} : null) })).toBe(true);
    expect(typingTarget(null)).toBe(false);
  });
});

describe('scene search', () => {
  const scenes = ['Candy cane', 'Candy cane slow chase', 'Warm white', 'Christmas Chase'].map((name) => ({ name }));
  it('keeps the order and matches every word, any case', () => {
    expect(filterScenes(scenes, '').map((s) => s.name)).toEqual(scenes.map((s) => s.name));
    expect(filterScenes(scenes, 'chase').map((s) => s.name)).toEqual(['Candy cane slow chase', 'Christmas Chase']);
    expect(filterScenes(scenes, 'CANE  slow').map((s) => s.name)).toEqual(['Candy cane slow chase']);
    expect(filterScenes(scenes, 'nothing')).toEqual([]);
  });
});

describe('page addresses in the demo', () => {
  it('sends every Setup address to Control, since the demo has no Setup', () => {
    for (const h of ['#/setup', '#/setup/house', '#map', '#map-demo']) expect(parseHash(h, true), h).toEqual(HOME);
  });

  it('still opens Create and Watch', () => {
    expect(parseHash('#/create', true).page).toBe('create');
    expect(parseHash('#/watch', true).page).toBe('watch');
  });

  it('leaves the real site alone', () => {
    expect(parseHash('#/setup/house', false).page).toBe('setup');
  });
});
