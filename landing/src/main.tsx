import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Self-hosted fonts, latin subset only. Same families as logickoder.dev.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/instrument-serif/latin-400-italic.css';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found. index.html must contain <div id="root">.');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
