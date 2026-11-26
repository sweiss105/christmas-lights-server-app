/** Point the app's requests at the in-browser stand-in (the demo build only; see main.tsx). */
import { setDemoHandler } from '../api';
import { loadDemoBackend, type DemoBackend } from './backend';

export function installDemo() {
  let backend: Promise<DemoBackend> | null = null;
  // Loaded on the first request; if the snapshot can't be fetched, the next request tries again.
  setDemoHandler(async (method, path, body) => (await (backend ??= loadDemoBackend().catch((e) => { backend = null; throw e; }))).handle(method, path, body));
}
