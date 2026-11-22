import { BADGE } from '../site';
import { DemoVideo } from './DemoVideo';
import { InstallBox } from './InstallBox';
import { Pill, Wrap } from './Layout';

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-h" data-loops>
      <Wrap className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] items-center gap-10 pt-12 pb-16 xs:gap-14 xs:pt-[88px] xs:pb-[104px]">
        <div className="rise flex min-w-0 flex-col gap-[26px]">
          <Pill tone="outline" className="self-start px-3 py-1.5 text-[13px] text-accent">
            {BADGE}
          </Pill>
          <h1 id="hero-h" className="display m-0 text-[clamp(46px,5.6vw,72px)]">
            Stop being the <span className="em">clipboard</span> between your coding agents.
          </h1>
          <p className="m-0 text-[17px] leading-[1.55] text-mute xs:text-[19px]">
            Claude Code, Antigravity and opencode sessions message each other by name. Each message wakes the receiving
            session in place, even when it is idle. No polling, no headless runs, no tmux.
          </p>
          <InstallBox />
          <p className="-mt-2 mb-0 text-sm text-mute">
            Then <code>/bridge</code> in each session. Node 22+. MIT.
          </p>
        </div>
        <DemoVideo />
      </Wrap>
    </section>
  );
}
