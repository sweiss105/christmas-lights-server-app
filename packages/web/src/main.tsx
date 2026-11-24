import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setWallClock } from '@xmas/engine';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// The preview's #TIME/#DATE use this device's clock.
setWallClock(() => new Date());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
