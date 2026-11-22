import { useState } from 'react';
import { THEME_KEY } from './theme-config';

type Theme = 'dark' | 'light';

function current(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  // The browser bar follows the page background, read from the tokens in styles.css.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked (private mode, site data off): the toggle still works for this visit.
  }
}

/** Reads the theme index.html set before first paint, and flips it. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(current);
  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    apply(next);
    setTheme(next);
  }
  return { theme, toggle };
}
