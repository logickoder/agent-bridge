import { THEME_KEY } from './theme-config';

type Theme = 'dark' | 'light';

/**
 * Flips the theme the pre-paint script set. Nothing here holds theme state: the toggle's icon and label
 * follow html[data-theme] through CSS (.when-dark / .when-light), so the prerendered HTML is right before
 * JavaScript loads.
 */
export function toggleTheme(): void {
  const root = document.documentElement;
  const next: Theme = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  // The browser bar follows the page background, read from the tokens in styles.css.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage blocked (private mode, site data off): the toggle still works for this visit.
  }
}
