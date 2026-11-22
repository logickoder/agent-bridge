import { INSTALL_NPM, NPM, REPO } from '../site';
import { OUTLINE_BUTTON, Terminal, Wrap } from './Layout';

export function Closing() {
  return (
    <section id="install" aria-labelledby="cta-h" className="border-t border-rule2">
      <Wrap className="flex flex-col items-center gap-6 py-[72px] text-center xs:py-28">
        <h2 id="cta-h" className="display m-0 text-[clamp(36px,5vw,56px)]">
          Two commands. Then let them talk.
        </h2>
        <Terminal className="max-w-full rounded-xl p-4 text-left text-[13px] leading-[1.8] xs:px-7 xs:py-5 xs:text-[15px]">
          {INSTALL_NPM}
        </Terminal>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={REPO} className="inline-flex min-h-11 items-center rounded-lg border border-accent bg-accent px-5 font-semibold text-on-accent hover:no-underline hover:brightness-110">
            Star on GitHub
          </a>
          <a href={NPM} className={`${OUTLINE_BUTTON} px-5 font-medium text-ink`}>
            View on npm
          </a>
        </div>
      </Wrap>
    </section>
  );
}
