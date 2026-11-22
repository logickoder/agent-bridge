/** Theme facts shared by the page (theme.ts) and the pre-paint script vite.config.ts writes into index.html. */

/** Same key as logickoder.dev, so the choice carries across both sites. */
export const THEME_KEY = 'logickoder-theme';

/** Page background per theme. Matches --bg in styles.css; paints before the stylesheet loads. */
export const PAGE_BG = { dark: '#0d1117', light: '#ffffff' } as const;
