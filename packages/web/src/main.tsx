import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setWallClock } from '@xmas/engine';
import { App } from './App';
import { DemoRibbon } from './demo/DemoRibbon';
import { DEMO } from './demo/flag';
import { installDemo } from './demo/install';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// The preview's #TIME/#DATE use this device's clock.
setWallClock(() => new Date());
if (DEMO) {
  installDemo();
  document.documentElement.classList.add('demo-site');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {DEMO && <DemoRibbon />}
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
