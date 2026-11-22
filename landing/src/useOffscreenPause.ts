import { useEffect } from 'react';

/** Marks each [data-loops] block data-offscreen while it is out of view, so its looping animations pause. */
export function useOffscreenPause(): void {
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.target.toggleAttribute('data-offscreen', !e.isIntersecting);
    });
    for (const el of document.querySelectorAll('[data-loops]')) io.observe(el);
    return () => io.disconnect();
  }, []);
}
