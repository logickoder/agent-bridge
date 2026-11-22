import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cli from '../package.json' with { type: 'json' };
import { PAGE_BG, THEME_KEY } from './src/theme-config.ts';

const BASE = '/agent-bridge/';

/** Files that already live in docs/assets, published at fixed paths (og:image needs a stable URL). */
const SHARED: Record<string, { from: string; type: string }> = {
  'favicon.svg': { from: 'logo.svg', type: 'image/svg+xml' },
  'assets/social-preview.png': { from: 'social-preview.png', type: 'image/png' },
};

function sharedAsset(from: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../docs/assets/${from}`, import.meta.url)));
}

/** Serves SHARED in dev and emits it on build, so each file has one copy in git. */
function sharedAssets(): Plugin {
  return {
    name: 'shared-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = SHARED[(req.url ?? '').split('?')[0]?.replace(BASE, '') ?? ''];
        if (!file) return next();
        res.setHeader('Content-Type', file.type);
        res.end(sharedAsset(file.from));
      });
    },
    generateBundle() {
      for (const [fileName, { from }] of Object.entries(SHARED)) {
        this.emitFile({ type: 'asset', fileName, source: sharedAsset(from) });
      }
    },
  };
}

/** Sets data-theme, the background and theme-color before first paint, from the same values theme.ts uses. */
function themeBoot(): Plugin {
  const key = JSON.stringify(THEME_KEY);
  const script = `(function(){var s=null;try{s=localStorage.getItem(${key})}catch(e){}var l=s==='light';document.documentElement.setAttribute('data-theme',l?'light':'dark');document.querySelector('meta[name="theme-color"]').setAttribute('content',l?'${PAGE_BG.light}':'${PAGE_BG.dark}')})()`;
  const style = `html{background:${PAGE_BG.dark}}html[data-theme='light']{background:${PAGE_BG.light}}body{margin:0}`;
  return {
    name: 'theme-boot',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { name: 'theme-color', content: PAGE_BG.dark }, injectTo: 'head' },
      { tag: 'script', children: script, injectTo: 'head' },
      { tag: 'style', children: style, injectTo: 'head' },
    ],
  };
}

/** Preloads the two faces the first screen needs: Inter body text and the Anton headline. */
function preloadFonts(): Plugin {
  const FIRST_SCREEN = /^assets\/(inter-latin-400-normal|anton-latin-400-normal)-[\w-]+\.woff2$/;
  return {
    name: 'preload-fonts',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, ctx) =>
        Object.keys(ctx.bundle ?? {})
          .filter((f) => FIRST_SCREEN.test(f))
          .map((f) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: BASE + f, crossorigin: '' },
            injectTo: 'head' as const,
          })),
    },
  };
}

// The page shows the CLI's version, read from the package that ships it.
export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), sharedAssets(), themeBoot(), preloadFonts()],
  define: {
    __CLI_VERSION__: JSON.stringify(cli.version),
  },
});
