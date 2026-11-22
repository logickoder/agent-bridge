import { useState } from 'react';
import { asset } from '../site';
import { PlayIcon } from './Icons';
import { Caption } from './Layout';

const VIDEO = asset('demo.mp4');
const POSTER = asset('poster-1200.webp');
const POSTER_SET = `${asset('poster-800.webp')} 800w, ${POSTER} 1200w`;
const frame =
  'relative block aspect-video overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_24px_80px_var(--glow)]';

/** Poster first. The 2.3 MB video downloads only after the visitor presses play. */
export function DemoVideo() {
  const [playing, setPlaying] = useState(false);

  return (
    <figure className="rise-late m-0 flex min-w-0 flex-col gap-3.5">
      {playing ? (
        <div className={frame}>
          <video
            src={VIDEO}
            poster={POSTER}
            controls
            autoPlay
            playsInline
            aria-label="agent-bridge demo, 77 seconds, with sound"
            className="block size-full bg-black object-cover"
          />
        </div>
      ) : (
        <a
          href={VIDEO}
          onClick={(e) => {
            e.preventDefault();
            setPlaying(true);
          }}
          aria-label="Play the 77 second demo, with sound"
          className={`${frame} group hover:no-underline`}
        >
          <img
            src={POSTER}
            srcSet={POSTER_SET}
            sizes="(min-width: 60rem) 50vw, 100vw"
            width={1200}
            height={675}
            fetchPriority="high"
            alt="Antigravity woken by a message from Claude Code, a frame from the demo"
            className="block size-full object-cover"
          />
          {/* Always dark: it sits on the video frame, not the page. */}
          <span className="ring absolute right-2.5 bottom-2.5 flex items-center gap-2.5 rounded-full border border-term-rule bg-term-bg/85 py-2 pr-3 pl-2.5 text-[13px] font-medium text-term-text group-hover:bg-term-bg/95 xs:right-4 xs:bottom-4 xs:py-2.5 xs:pr-4 xs:pl-3 xs:text-sm">
            <PlayIcon width={18} height={18} className="fill-term-accent" />
            Play · 1:17 · sound on
          </span>
        </a>
      )}
      <Caption>fig. 1 · plan with one agent, build with another, reach a teammate's</Caption>
    </figure>
  );
}
