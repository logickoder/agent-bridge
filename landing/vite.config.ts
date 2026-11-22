import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cli from '../package.json' with { type: 'json' };
import { PAGE_BG, THEME_KEY } from './src/theme-config.ts';

/** The page's public address. Everything else (base path, canonical, og tags, JSON-LD) derives from it. */
// A homepage without its trailing slash would break the base path and every URL below.
const SITE = cli.homepage.endsWith('/') ? cli.homepage : `${cli.homepage}/`;
const BASE = new URL(SITE).pathname;
const REPO = cli.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const NPM = `https://www.npmjs.com/package/${cli.name}`;

const SEO = {
  title: 'agent-bridge · messaging between Claude Code, Antigravity and opencode sessions',
  description:
    'Claude Code, Antigravity and opencode sessions message each other by name. Each message wakes the receiving session in place.',
  ogDescription:
    'Stop being the clipboard between your coding agents. Claude Code, Antigravity and opencode sessions message each other by name.',
  image: {
    url: `${SITE}assets/social-preview.png`,
    width: '1280',
    height: '640',
    alt: 'agent-bridge logo and name. Your agent sessions, messaging each other. On one machine, or across many. Claude Code, Antigravity, opencode.',
  },
};

/** Where the server build of src/entry-server.tsx lands. Read back by buildApp to prerender. */
const SSR_OUT = fileURLToPath(new URL('node_modules/.tmp/ssr/', import.meta.url));
const ROOT_MARKER = '<!--app-html-->';

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
    applyToEnvironment: (env) => env.name === 'client',
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

/** Title, description, canonical, Open Graph and SoftwareApplication JSON-LD, all from SEO and package.json. */
function seo(): Plugin {
  const meta = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'meta', attrs, injectTo: 'head' });
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: cli.name.split('/').pop(),
    description: SEO.description,
    url: SITE,
    applicationCategory: 'DeveloperApplication',
    softwareVersion: cli.version,
    license: `https://opensource.org/licenses/${cli.license}`,
    downloadUrl: NPM,
    sameAs: [REPO],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: cli.author.name, url: cli.author.url },
  };
  return {
    name: 'seo',
    transformIndexHtml: () => [
      { tag: 'title', children: SEO.title, injectTo: 'head' },
      meta({ name: 'description', content: SEO.description }),
      { tag: 'link', attrs: { rel: 'canonical', href: SITE }, injectTo: 'head' },
      meta({ property: 'og:type', content: 'website' }),
      meta({ property: 'og:site_name', content: 'logickoder' }),
      meta({ property: 'og:title', content: SEO.title }),
      meta({ property: 'og:description', content: SEO.ogDescription }),
      meta({ property: 'og:url', content: SITE }),
      meta({ property: 'og:image', content: SEO.image.url }),
      meta({ property: 'og:image:width', content: SEO.image.width }),
      meta({ property: 'og:image:height', content: SEO.image.height }),
      meta({ property: 'og:image:alt', content: SEO.image.alt }),
      meta({ name: 'twitter:card', content: 'summary_large_image' }),
      // JSON.stringify output is safe in a script tag once "<" is escaped.
      { tag: 'script', attrs: { type: 'application/ld+json' }, children: JSON.stringify(jsonLd).replace(/</g, '\\u003c'), injectTo: 'head' },
    ],
  };
}

// The page shows the CLI's version, read from the package that ships it.
// `vite build` builds the client, then a server build of the page, and prerenders it into index.html
// (the pre-rendering setup from Vite's SSR guide), so crawlers that skip JavaScript still read the page.
export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), sharedAssets(), themeBoot(), preloadFonts(), seo()],
  define: {
    __CLI_VERSION__: JSON.stringify(cli.version),
  },
  environments: {
    ssr: { build: { outDir: SSR_OUT, copyPublicDir: false, rollupOptions: { input: 'src/entry-server.tsx' } } },
  },
  builder: {
    async buildApp(builder) {
      const { client, ssr } = builder.environments;
      if (!client || !ssr) throw new Error('Prerender failed. Vite did not create the client and ssr environments. Check `environments` in landing/vite.config.ts.');
      await builder.build(client);
      await builder.build(ssr);
      const { render } = (await import(pathToFileURL(`${SSR_OUT}entry-server.js`).href)) as { render: () => string };
      const page = fileURLToPath(new URL('dist/index.html', import.meta.url));
      const html = readFileSync(page, 'utf8');
      if (!html.includes(ROOT_MARKER)) {
        throw new Error(`Prerender failed. dist/index.html has no ${ROOT_MARKER}. Keep it inside #root in index.html.`);
      }
      // A function, so `$&` or `$'` in the page are not read as replacement patterns.
      writeFileSync(page, html.replace(ROOT_MARKER, () => render()));
    },
  },
});
