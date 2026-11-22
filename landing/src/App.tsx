import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Beats } from './components/Beats';
import { HowItWorks } from './components/HowItWorks';
import { Networks } from './components/Networks';
import { Closing } from './components/Closing';
import { Footer } from './components/Footer';
import { useOffscreenPause } from './useOffscreenPause';

export function App() {
  useOffscreenPause();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-10 focus:rounded-lg focus:bg-accent focus:px-3.5 focus:py-2.5 focus:font-semibold focus:text-on-accent"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Beats />
        <HowItWorks />
        <Networks />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
