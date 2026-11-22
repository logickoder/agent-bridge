import type { ReactNode } from 'react';
import { LockIcon } from './Icons';
import { Eyebrow, Pill } from './Layout';

/** A wire between two boxes. Vertical on phones, horizontal from md up. A dot travels it unless motion is reduced. */
function Wire({ label, live = false }: { label?: string; live?: boolean }) {
  return (
    <div aria-hidden="true" className={`wire ${live ? 'wire-live' : ''}`}>
      <span className="wire-line" />
      {live && <span className="wire-track" />}
      {label && <span className="wire-label">{label}</span>}
    </div>
  );
}

/** A session or daemon card: title, optional badge, peer name, optional body below. */
function Box({
  title,
  name,
  accent = false,
  badge,
  children,
}: {
  title: string;
  name: string;
  accent?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 rounded-xl border bg-surface px-4 py-3.5 ${accent ? 'border-accent' : 'border-rule'}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold text-ink">{title}</span>
        {badge}
      </div>
      <code className="text-[13px] text-mute">{name}</code>
      {children}
    </div>
  );
}

const QUEUES = [
  { peer: 'myapp-agy', count: 1, live: true },
  { peer: 'myapp-opencode', count: 0, live: false },
];

export function Diagram() {
  return (
    <div className="flex flex-col gap-8">
      {/* One machine */}
      <div className="flex flex-col gap-4">
        <Eyebrow>On one machine</Eyebrow>
        <div className="grid grid-cols-1 items-center md:grid-cols-[1fr_88px_1.1fr_minmax(0,1fr)]">
          <Box title="Claude Code" name="myapp-claude">
            <code className="mt-2 rounded-md bg-term-bg px-3 py-2 text-[12.5px] text-term-text">
              <span className="text-term-accent">›</span> send myapp-agy "ready for review"
            </code>
          </Box>

          <Wire label="send" live />

          <div className="flex flex-col gap-3 rounded-xl border border-accent bg-surface px-4 py-4 shadow-[0_0_0_6px_var(--glow)]">
            <div className="flex flex-col gap-1">
              <span className="display text-[22px] text-ink">agent-bridge daemon</span>
              <span className="font-mono text-[12px] text-mute">queues on disk, per peer</span>
            </div>
            <div className="flex flex-col gap-1.5 font-mono text-[13px]">
              {QUEUES.map((q) => (
                <div
                  key={q.peer}
                  className={`flex items-center justify-between rounded-md border border-rule2 bg-bg px-3 py-2 ${q.live ? '' : 'text-mute'}`}
                >
                  <span>{q.peer}</span>
                  <span className="flex items-center gap-2">
                    {q.live && <span className="pulse size-2 rounded-full bg-accent" />}
                    {q.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 items-start gap-3 md:flex md:items-stretch md:flex-col md:gap-4">
            <div className="grid grid-cols-1 items-center md:grid-cols-[132px_1fr]">
              <Wire label={"wakes\u00a0· agentapi"} live />
              <Box
                title="Antigravity"
                name="myapp-agy"
                accent
                badge={
                  <Pill tone="accent" className="pulse px-2 py-0.5 text-[11px]">
                    woken
                  </Pill>
                }
              />
            </div>
            <div className="grid grid-cols-1 items-center md:grid-cols-[132px_1fr]">
              <Wire label="plugin" />
              <Box title="opencode" name="myapp-opencode" />
            </div>
          </div>
        </div>
      </div>

      <hr className="m-0 border-0 border-t border-dashed border-rule" />

      {/* Across machines */}
      <div className="flex flex-col gap-4">
        <Eyebrow>Across machines · optional</Eyebrow>
        <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
          <p className="m-0 text-[15px] leading-[1.6] text-mute">
            Share a session and it gets an address: <code className="text-accent">myapp-claude@amy</code>. Same daemon.
            No agent-bridge server in between.
          </p>
          <div className="grid grid-cols-1 items-center md:grid-cols-[auto_1fr_auto_1fr_minmax(0,1.2fr)] md:gap-y-2">
            <Pill tone="accent" className="justify-self-center px-3.5 py-1.5 text-[13px]">
              <LockIcon className="mr-1.5 inline size-3.5 -translate-y-px fill-current" />
              sealed
            </Pill>
            <Wire label="end-to-end encrypted" live />
            <span
              aria-hidden="true"
              className="block h-6 w-24 justify-self-center rounded border border-rule bg-[repeating-linear-gradient(135deg,var(--rule)_0_3px,transparent_3px_9px)] md:h-20 md:w-6"
            />
            {/* Below the tunnel: next in flow on phones, its own row under the tunnel from md. */}
            <span className="mt-2 text-center font-mono text-[12px] leading-snug text-mute md:col-start-3 md:row-start-2 md:mt-0 md:self-start md:whitespace-nowrap">
              tunnel you host
              <br />
              sees ciphertext only
            </span>
            <Wire live />
            <div className="flex flex-col gap-2 rounded-xl border border-dashed border-rule p-2.5">
              <div className="rounded-xl border border-rule bg-surface px-4 py-3 text-center font-semibold">their daemon</div>
              <div className="flex items-center justify-center gap-2 font-mono text-[12px] text-mute">
                <span aria-hidden="true">↓</span> wakes
              </div>
              <Box title="Claude Code" name="planner@bob" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
