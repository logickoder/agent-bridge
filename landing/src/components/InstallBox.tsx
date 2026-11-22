import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { INSTALL_NPM, INSTALL_SOURCE } from '../site';
import { CopyIcon } from './Icons';
import { OUTLINE_BUTTON } from './Layout';

const METHODS = [
  { id: 'npm', label: 'npm', command: INSTALL_NPM },
  { id: 'source', label: 'From source', command: INSTALL_SOURCE },
] as const;

type MethodId = (typeof METHODS)[number]['id'];
type CopyState = 'idle' | 'copied' | 'failed';

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};
const RESET_MS = 2000;
// Client-only page: the clipboard API either works here or it doesn't, for the whole visit.
const CAN_COPY = Boolean(navigator.clipboard) && window.isSecureContext;

/** Tabbed install commands with a copy button (shown only where the clipboard API works). */
export function InstallBox() {
  const [active, setActive] = useState<MethodId>('npm');
  const [copy, setCopy] = useState<CopyState>('idle');
  const tabRefs = useRef<Partial<Record<MethodId, HTMLButtonElement | null>>>({});
  const method = METHODS.find((m) => m.id === active) ?? METHODS[0];

  useEffect(() => {
    if (copy === 'idle') return;
    const t = setTimeout(() => setCopy('idle'), RESET_MS);
    return () => clearTimeout(t);
  }, [copy]);

  function pick(id: MethodId, focus: boolean) {
    setActive(id);
    setCopy('idle');
    if (focus) tabRefs.current[id]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = METHODS.length - 1;
    const target: Record<string, number> = {
      ArrowRight: (index + 1) % METHODS.length,
      ArrowLeft: (index + last) % METHODS.length,
      Home: 0,
      End: last,
    };
    const to = target[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = METHODS[to];
    if (next) pick(next.id, true);
  }

  function onCopy() {
    navigator.clipboard.writeText(method.command).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-surface">
      <div role="tablist" aria-label="Install method" className="flex gap-1 border-b border-rule2 px-2 pt-2">
        {METHODS.map((m, i) => {
          const on = m.id === active;
          return (
            <button
              key={m.id}
              ref={(el) => {
                tabRefs.current[m.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${m.id}`}
              aria-controls={`cmd-${m.id}`}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => pick(m.id, false)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`min-h-11 cursor-pointer border-0 border-b-2 bg-transparent px-4 text-sm font-medium ${
                on ? 'border-accent text-ink' : 'border-transparent text-mute hover:text-ink'
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-start justify-between gap-3 py-3.5 pr-3 pl-3.5 xs:py-4 xs:pr-4 xs:pl-5">
        {/* Both panels stay in the DOM so each tab's aria-controls resolves. */}
        {METHODS.map((m) => (
          <pre
            key={m.id}
            role="tabpanel"
            id={`cmd-${m.id}`}
            aria-labelledby={`tab-${m.id}`}
            hidden={m.id !== active}
            className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7] text-ink xs:text-[15px]"
          >
            {m.command}
            <span className="caret" aria-hidden="true" />
          </pre>
        ))}
        {CAN_COPY && (
          <button
            type="button"
            onClick={onCopy}
            className={`${OUTLINE_BUTTON} flex-none gap-1.5 px-3 text-[13px] font-medium`}
          >
            <CopyIcon width={16} height={16} />
            <span aria-live="polite" title={copy === 'failed' ? 'Select the text and copy it yourself.' : undefined}>
              {COPY_LABEL[copy]}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
