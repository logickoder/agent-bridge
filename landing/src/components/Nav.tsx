import { DOCS, REPO, VERSION } from '../site';
import { toggleTheme } from '../theme';
import { GitHubIcon, Logo, MoonIcon, SunIcon } from './Icons';
import { OUTLINE_BUTTON, Pill, Wrap } from './Layout';

export function Nav() {
  return (
    <header className="border-b border-rule2">
      <Wrap>
        <nav aria-label="Main" className="flex items-center justify-between gap-2 py-3.5 xs:gap-4 xs:py-[18px]">
          <a href="#top" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[15px] font-semibold hover:no-underline xs:gap-2.5 xs:text-[17px]">
            <Logo width={28} height={28} />
            <span>agent-bridge</span>
            <Pill tone="outline" className="px-1.5 py-0.5 text-[11px] font-normal text-mute xs:px-2 xs:text-xs">v{VERSION}</Pill>
          </a>
          <div className="flex items-center gap-2 whitespace-nowrap xs:gap-3 text-[15px] text-ink2 md:gap-7">
            <a className="hidden md:inline" href="#how">How it works</a>
            <a className="hidden md:inline" href="#networks">Networks</a>
            <a className="hidden md:inline" href={DOCS}>Docs</a>
            {/* Both states are in the HTML; CSS shows the one matching html[data-theme]. */}
            <button type="button" onClick={toggleTheme} className={OUTLINE_BUTTON}>
              <span className="when-dark">
                <SunIcon width={18} height={18} />
                <span className="sr-only">Switch to light theme</span>
              </span>
              <span className="when-light">
                <MoonIcon width={18} height={18} />
                <span className="sr-only">Switch to dark theme</span>
              </span>
            </button>
            <a href={REPO} aria-label="agent-bridge on GitHub" className={`${OUTLINE_BUTTON} w-11 xs:w-auto xs:px-3.5`}>
              <GitHubIcon width={16} height={16} />
              <span className="hidden xs:inline">GitHub</span>
            </a>
          </div>
        </nav>
      </Wrap>
    </header>
  );
}
