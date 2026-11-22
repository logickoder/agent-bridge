import type { ReactNode } from 'react';
import { Band, Card, H2, Kicker, Terminal } from './Layout';

function Beat({ kicker, title, children, term }: { kicker: string; title: string; children: ReactNode; term: ReactNode }) {
  return (
    <Card as="article" className="gap-4 bg-surface p-7">
      <Kicker accent>{kicker}</Kicker>
      <h3 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">{title}</h3>
      <p className="m-0 text-base leading-[1.6] text-mute">{children}</p>
      <Terminal className="mt-auto rounded-[10px] px-4 py-3.5 text-[13px] leading-[1.7]">{term}</Terminal>
    </Card>
  );
}

export function Beats() {
  return (
    <Band labelledBy="beats-h" className="flex flex-col gap-12">
      <H2 id="beats-h" className="max-w-[760px]">
        Your agents already know how to talk. They just had no line.
      </H2>
      <div data-loops className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-5">
        <Beat
          kicker="01 · named peers"
          title="Every session gets a name"
          term={'$ agent-bridge peers\nOnline: myapp-claude, myapp-agy,\n        myapp-opencode'}
        >
          Run <code>/bridge</code> and the session joins as <code>&lt;folder&gt;-&lt;kind&gt;</code>, or any name you pick.
          Ask it to message another by name.
        </Beat>
        <Beat
          kicker="02 · wakes in place"
          title="Idle sessions pick it up"
          term={
            <>
              {'myapp-claude → myapp-agy\n"ready for review"\n'}
              <span className="pulse text-term-accent">● woken</span>
            </>
          }
        >
          Each agent is woken through its own native interface. The message lands in the session you already have open,
          not a headless copy.
        </Beat>
        <Beat
          kicker="03 · across machines"
          title="Reach a teammate's agent"
          term={'/bridge share\n→ myapp-claude@amy\nsend planner@bob "spec is in"'}
        >
          Share a session and it gets an address. Messages go end to end encrypted through a tunnel one of you hosts.
        </Beat>
      </div>
    </Band>
  );
}
