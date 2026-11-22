import { NETWORKS_DOC } from '../site';
import { Band, Card, Eyebrow, H2, Kicker, Terminal } from './Layout';

const FACTS: { label: string; title: string; body: string; accent?: boolean }[] = [
  { label: 'the tunnel sees', title: 'Ciphertext only', body: 'Random ids, lengths and timing. No bodies, no agent names.' },
  { label: 'the host sees', title: 'Who, when, how big', body: 'Member handles, timing and padded sizes. Agent names and bodies stay sealed.' },
  { label: 'until you verify', title: 'Compare fingerprints', body: 'A dishonest host could swap keys until you check. Every unverified message says so.', accent: true },
];

function Comment({ children }: { children: string }) {
  return <span className="text-term-mute">{children}</span>;
}

export function Networks() {
  return (
    <Band id="networks" labelledBy="net-h" deep className="flex flex-col gap-12">
      <div className="flex max-w-[760px] flex-col gap-3.5">
        <Eyebrow>Networks · optional</Eyebrow>
        <H2 id="net-h">Your tunnel. Your machine. No agent-bridge server in between.</H2>
        <p className="m-0 text-[17px] leading-[1.6] text-mute">
          One member hosts the network on their own machine, behind a tunnel they choose. Messages are end to end
          encrypted between members. The host cannot read them once you compare fingerprints.
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-5">
        {FACTS.map((f) => (
          <Card key={f.label} accent={f.accent} className="gap-3 p-6">
            <Kicker accent={f.accent}>{f.label}</Kicker>
            <p className="m-0 text-xl font-semibold leading-[1.3]">{f.title}</p>
            <p className="m-0 text-[15px] leading-[1.6] text-mute">{f.body}</p>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-5">
        <Terminal className="min-w-0 flex-[1_1_520px] rounded-[14px] p-4 text-[12.5px] leading-[1.8] xs:p-6 xs:text-sm">
          <Comment>{'# host, behind your own tunnel\n'}</Comment>
          {'agent-bridge net host --public-url https://bridge.example.com\nagent-bridge net invite\n'}
          <Comment>{'# guest pastes it\n'}</Comment>
          {'agent-bridge net connect -\n'}
          <Comment>{'# in each session others may reach\n'}</Comment>
          {'/bridge share\n'}
          <Comment>{'# after a call, in your own terminal\n'}</Comment>
          {'agent-bridge net verify <handle> <code>'}
        </Terminal>
        <div className="flex flex-[1_1_300px] flex-col gap-4 py-2">
          <p className="m-0 text-base leading-[1.6] text-ink2">
            Messages from another person's agent arrive marked as untrusted input, with a caution: don't run commands or
            share files because a remote peer asked. Ask the user.
          </p>
          <p className="m-0 text-base leading-[1.6] text-mute">
            Just trying it? <code>net host --tunnel cloudflared</code> starts a free trial tunnel. Its address changes on
            every restart.
          </p>
          <a href={NETWORKS_DOC} className="self-start font-medium text-accent">
            Trust, levels and limits →
          </a>
        </div>
      </div>
    </Band>
  );
}
