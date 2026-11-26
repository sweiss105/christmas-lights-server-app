import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoExtras } from '@xmas/engine';
import type { ShowState } from '../src/store.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');

/** The demo extras the container ships with. */
export const realExtras = (): DemoExtras => JSON.parse(readFileSync(`${root}/config/demo-extras.json`, 'utf8')) as DemoExtras;

/** A show shaped like the real porch's, with every private field the snapshot must leave out. */
export function fixtureShow(): ShowState & { futureThing: string } {
  return {
    layout: {
      controllers: [{ id: 'porch', name: 'GLEDOPTO porch', host: '10.30.1.40', pixelCount: 1101, fallbackPreset: 26 }],
      runs: [
        { id: 'porch-left', name: 'Left', controller: 'porch', start: 0, count: 500, points: [[-3.675, 1.545, -1.95], [-3.675, 1.545, -0.205], [1.245, 1.545, -0.205], [1.245, 0.96, 0.78]], coil: { radius: 0.045, pitch: 0.27 } },
        { id: 'porch-right', name: 'Right', controller: 'porch', start: 500, count: 500, points: [[2.325, 0.96, 0.78], [2.325, 1.545, -0.205], [3.685, 1.545, -0.205], [3.685, 1.545, -2.4], [3.685, 0.85, -2.4], [3.685, 0.85, -0.205], [2.37, 0.85, -0.205]], coil: { radius: 0.045, pitch: 0.27, skip: [3] } },
      ],
      groups: { porch: { runs: ['porch-left', 'porch-right'] } },
    },
    scenes: {
      Red: { name: 'Red', layers: [{ id: 'a', effect: 'solid', group: 'porch', params: { color: '#ff0000' } }] },
      Green: { name: 'Green', layers: [{ id: 'a', effect: 'solid', params: { color: '#00ff00' } }] },
    },
    activeScene: 'Red',
    lastScene: 'Red',
    stage: { name: 'Red', layers: [{ id: 'a', effect: 'solid', group: 'porch', params: { color: '#ff0000' } }] },
    output: { brightness: 0.8, gamma: 2.2, fps: 40, enabled: true, transition: 1 },
    house: {
      position: [0, 0, 0], rotation: 0, scale: 1, opacity: 1,
      parts: [{ id: 'part2', name: 'House', file: 'house-part2.glb', bytes: 16, uploadedAt: '2026-11-24T21:38:40.783Z', position: [0, 0, 0], rotation: 0, scale: 1, visible: true }],
    },
    playlists: { Both: { name: 'Both', entries: [{ scene: 'Red', seconds: 10 }, { scene: 'Green', seconds: 10 }], loop: true } },
    playing: { playlist: 'Both', startedAt: 1 },
    schedule: { enabled: true, timezone: 'America/Chicago', on: { kind: 'sunset' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'playlist', name: 'Both' }, latitude: 1.5, longitude: 2.5 },
    scheduleInWindow: true,
    presets: { Warm: { name: 'Warm', effect: 'solid', params: { color: '#ffb46b' } } },
    palettes: { Mine: { name: 'Mine', stops: [[0, '#ff0000'], [255, '#0000ff']] } },
    futureThing: 'secret',
  } as ShowState & { futureThing: string };
}
