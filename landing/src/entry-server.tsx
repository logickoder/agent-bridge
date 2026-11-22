import { renderToString } from 'react-dom/server';
import { App } from './App';

/** The page as static HTML for the prerender step in vite.config.ts. StrictMode renders nothing, so it is left out. */
export function render(): string {
  return renderToString(<App />);
}
