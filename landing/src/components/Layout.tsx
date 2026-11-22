import type { ReactNode } from 'react';

/** Page column: 1200px max, 24px gutter, 16px on phones. */
export function Wrap({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto max-w-[1200px] px-4 xs:px-6 ${className}`}>{children}</div>;
}

/** A full-width band with a top rule and the standard vertical rhythm. */
export function Band({
  id,
  labelledBy,
  deep = false,
  className = '',
  children,
}: {
  id?: string;
  labelledBy: string;
  deep?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`border-t border-rule2 ${deep ? 'bg-deep' : ''}`}>
      <Wrap className={`py-16 xs:py-24 ${className}`}>{children}</Wrap>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] uppercase tracking-[0.08em] text-mute">{children}</span>;
}

export function H2({ id, className = '', children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <h2 id={id} className={`display m-0 text-[clamp(34px,4.5vw,50px)] ${className}`}>
      {children}
    </h2>
  );
}

/** Terminal block. Stays dark in both themes. Callers set padding, radius and type size. */
export function Terminal({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <pre
      className={`m-0 overflow-x-auto whitespace-pre-wrap border border-term-rule bg-term-bg font-mono text-term-text ${className}`}
    >
      {children}
    </pre>
  );
}

export function Caption({ className = '', children }: { className?: string; children: ReactNode }) {
  return <figcaption className={`font-mono text-[13px] text-mute ${className}`}>{children}</figcaption>;
}

/** Bordered control: theme toggle, GitHub link, copy button, secondary call to action. */
export const OUTLINE_BUTTON =
  'inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-rule bg-transparent text-ink2 hover:border-mute hover:no-underline';

/** Rounded label. accent: filled green. outline: ruled border. Callers set size and text colour. */
export function Pill({ tone, className = '', children }: { tone: 'accent' | 'outline'; className?: string; children: ReactNode }) {
  const look = tone === 'accent' ? 'bg-accent text-on-accent' : 'border border-rule';
  return <span className={`rounded-full font-mono ${look} ${className}`}>{children}</span>;
}

/** Feature card that lifts on hover and rises in on scroll. Callers set padding, gap and background. */
export function Card({
  accent = false,
  as: Tag = 'div',
  className = '',
  children,
}: {
  accent?: boolean;
  as?: 'div' | 'article';
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={`lift reveal flex flex-col rounded-[14px] border ${accent ? 'border-accent' : 'border-rule'} ${className}`}>
      {children}
    </Tag>
  );
}

export function Kicker({ accent = false, children }: { accent?: boolean; children: ReactNode }) {
  return <span className={`font-mono text-[13px] ${accent ? 'text-accent' : 'text-mute'}`}>{children}</span>;
}
