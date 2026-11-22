import { Diagram } from './Diagram';
import { Band, Caption, Eyebrow, H2 } from './Layout';

const WAKES = [
  { agent: 'Claude Code', wake: "Push into the session's inbox socket", fallbacks: 'Plugin monitor, channel' },
  { agent: 'Antigravity', wake: <code>agy agentapi send-message</code>, fallbacks: 'Background listener, PreInvocation hook' },
  { agent: 'opencode', wake: 'Plugin prompts the session', fallbacks: 'None' },
];

export function HowItWorks() {
  return (
    <Band id="how" labelledBy="how-h" className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex max-w-[620px] flex-col gap-3.5">
          <Eyebrow>How it works</Eyebrow>
          <H2 id="how-h">One local daemon. Disk queues. At-least-once.</H2>
        </div>
        <p className="m-0 max-w-[420px] text-base leading-[1.6] text-mute">
          Peers talk over a Unix socket. A message leaves the queue only when the receiver acks it, so a busy or
          restarted session still gets it.
        </p>
      </div>

      <figure data-loops className="reveal m-0 rounded-2xl border border-rule bg-bg p-4 sm:p-8">
        <Diagram />
        <Caption className="mt-8">fig. 2 · one machine on top, across machines below</Caption>
      </figure>

      <div className="overflow-x-auto rounded-xl border border-rule">
        <table className="w-full min-w-[640px] border-collapse text-left text-[15px]">
          <thead>
            <tr className="bg-surface text-[13px] text-mute">
              {['Agent', 'Default wake', 'Fallbacks'].map((h) => (
                <th key={h} scope="col" className="px-5 py-3.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WAKES.map((w) => (
              <tr key={w.agent} className="border-t border-rule2">
                <td className="px-5 py-4 font-semibold">{w.agent}</td>
                <td className="px-5 py-4 text-ink2">{w.wake}</td>
                <td className="px-5 py-4 text-mute">{w.fallbacks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Band>
  );
}
