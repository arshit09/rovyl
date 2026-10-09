import React from 'react';
import ReactDOM from 'react-dom/client';
import './fonts.css';
import './index.css';
import RadialApp from './RadialApp';
import { ErrorBoundary } from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

/**
 * No `StrictMode` here, deliberately.
 *
 * Its double-invoked effects are a development-only sanity check, and the price is paid exactly
 * where this document cannot afford it: every subscription in `RadialApp` is set up, torn down and
 * set up again, and the open handshake's `paintToken` acknowledgement — the thing main waits on
 * before it reveals an already-painted HWND — would be sent twice for one open. The settings
 * window keeps StrictMode; it has no frame budget to blow.
 */
const root = ReactDOM.createRoot(rootElement);
root.render(
  <ErrorBoundary>
    <RadialApp />
  </ErrorBoundary>,
);
