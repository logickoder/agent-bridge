import { describe, expect, it } from 'vitest'
import { Hub, REMOTE_QUEUE_CAP, type Conn, type NetView, type Store } from './hub.js'
import type { Message, Peer, Reply, Request } from '../schema.js'

class FakeConn implements Conn {
  readonly replies: Reply[] = []
  closed = false
  send(reply: Reply): void {
    this.replies.push(reply)
  }
  end(): void {
    this.closed = true
  }
  last(): Reply | undefined {
    return this.replies.at(-1)
  }
  msgs(): Message[] {
    return this.replies.flatMap(r => (r.type === 'msg' ? [r.msg] : []))
  }
}

/** A link that never ends on a reply: the hub keeps it until detachLink. */
class FakeLink extends FakeConn {
  override end(): void {}
}

function memoryStore(): Store & { queues: Map<string, Message[]>; peers: Peer[] } {
  const s = {
    peers: [] as Peer[],
    queues: new Map<string, Message[]>(),
    load: () => ({ peers: structuredClone(s.peers), queues: structuredClone(s.queues), endpoints: [] }),
    saveEndpoints: () => {},
    savePeers: (p: Peer[]) => {
      s.peers = structuredClone(p)
    },
    saveQueue: (name: string, msgs: Message[]) => {
      s.queues.set(name, structuredClone(msgs))
    },
    dropQueue: (name: string) => {
      s.queues.delete(name)
    },
  }
  return s
}

const ALICE = 'sess-alice'
const view = (over: Partial<NetView> = {}): NetView => ({
  network: 'team',
  self: 'alice',
  connected: true,
  members: [{ handle: 'bob', keyVerified: false, blocked: false, peers: [{ name: 'planner', kind: 'claude', online: true }] }],
  ...over,
})

function setup(store = memoryStore()) {
  let n = 0
  let changed = 0
  const clock = { now: new Date('2026-11-19T00:00:00Z') }
  const logs: string[] = []
  const hub = new Hub({
    store,
    now: () => clock.now,
    newId: () => `m${++n}`,
    pid: 1,
    log: m => logs.push(m),
    net: { changed: () => void changed++ },
  })
  const call = (req: Exclude<Request, { op: 'shutdown' | 'net' }>, conn = new FakeConn()): FakeConn => {
    hub.handle(req, conn)
    return conn
  }
  const listen = (as: string, session: string) => call({ op: 'listen', as, kind: 'claude', session, stream: true })
  const share = (as: string, session = ALICE, on = true) => call({ op: 'share', as, sessions: [session], on })
  const sendRemote = (to: string, text = 'hi', from = 'coder', sessions: string[] = [ALICE]) => call({ op: 'send', from, to, text, sessions })
  const status = () => {
    const r = call({ op: 'status' }).last()
    if (r?.type !== 'status') throw new Error('no status')
    return r
  }
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }
  /** A joined, shared local peer `coder` on a network, with a link attached. */
  const ready = () => {
    const coder = listen('coder', ALICE)
    share('coder')
    hub.setNetwork(view())
    const link = new FakeLink()
    hub.attachLink(link)
    return { coder, link }
  }
  return { hub, store, call, listen, share, sendRemote, status, advance, ready, logs, changes: () => changed }
}

const error = (c: FakeConn): string => {
  const r = c.last()
  return r?.type === 'error' ? r.message : `not an error: ${JSON.stringify(r)}`
}

describe('network: sending', () => {
  it('refuses a remote send with no network', () => {
    const { listen, share, sendRemote } = setup()
    listen('coder', ALICE)
    share('coder')
    expect(error(sendRemote('planner@bob'))).toMatch(/No network/)
  })

  it('needs a checked sender', () => {
    const { ready, sendRemote, call } = setup()
    ready()
    expect(error(sendRemote('planner@bob', 'hi', 'coder', []))).toMatch(/checked sender/)
    expect(error(call({ op: 'send', from: 'shell', to: 'planner@bob', text: 'hi' }))).toMatch(/checked sender/)
  })

  it('needs the sender to be shared, so replies can reach it', () => {
    const { ready, share, sendRemote } = setup()
    ready()
    share('coder', ALICE, false)
    expect(error(sendRemote('planner@bob'))).toMatch(/not shared on the network/)
  })

  it('names the members when the member is unknown', () => {
    const { ready, sendRemote } = setup()
    ready()
    expect(error(sendRemote('planner@carol'))).toMatch(/No member "carol".*Members: bob/)
  })

  it('refuses while a member key change is not trusted', () => {
    const { ready, hub, sendRemote } = setup()
    ready()
    hub.setNetwork(view({ members: [{ handle: 'bob', keyVerified: false, blocked: true, peers: [{ name: 'planner', kind: 'claude', online: true }] }] }))
    expect(error(sendRemote('planner@bob'))).toMatch(/key changed.*net verify bob/)
  })

  it('lists what the member shares when the agent is not one of them', () => {
    const { ready, sendRemote } = setup()
    ready()
    expect(error(sendRemote('ghost@bob'))).toMatch(/"ghost" is not shared by bob. Shared by bob: planner@bob/)
  })

  it('hands the message to the link and reports the key state', () => {
    const { ready, sendRemote } = setup()
    const { link } = ready()
    const r = sendRemote('planner@bob', 'PAPAYA').last()
    expect(r).toMatchObject({ type: 'sent', to: 'planner@bob', via: 'network', pushed: true, keyVerified: false })
    expect(link.msgs()).toMatchObject([{ from: 'coder', to: 'planner@bob', text: 'PAPAYA', verified: true }])
  })

  it('routes <agent>@<self> locally', () => {
    const { ready, listen, call } = setup()
    ready()
    const other = listen('other', 'sess-other')
    call({ op: 'send', from: 'coder', to: 'other@alice', text: 'local', sessions: [ALICE] })
    expect(other.msgs().map(m => m.text)).toEqual(['local'])
  })
})

describe('network: outbox', () => {
  it('keeps one message in flight per remote key, and moves on after linkAck', () => {
    const { ready, hub, sendRemote, store } = setup()
    const { link } = ready()
    sendRemote('planner@bob', 'one')
    sendRemote('planner@bob', 'two')
    expect(link.msgs().map(m => m.text)).toEqual(['one'])
    expect(store.queues.get('planner@bob')).toHaveLength(2)
    hub.linkAck('planner@bob', 'm1')
    expect(link.msgs().map(m => m.text)).toEqual(['one', 'two'])
    expect(store.queues.get('planner@bob')).toHaveLength(1)
  })

  it('does not let one slow recipient block another', () => {
    const { ready, hub, sendRemote } = setup()
    const { link } = ready()
    hub.setNetwork(
      view({
        members: [
          { handle: 'bob', keyVerified: true, blocked: false, peers: [{ name: 'planner', kind: 'claude', online: true }, { name: 'tester', kind: 'agy', online: true }] },
        ],
      }),
    )
    sendRemote('planner@bob', 'a')
    sendRemote('tester@bob', 'b')
    expect(link.msgs().map(m => m.to)).toEqual(['planner@bob', 'tester@bob'])
  })

  it('queues while no link is attached and sends once one attaches', () => {
    const { listen, share, hub, sendRemote } = setup()
    listen('coder', ALICE)
    share('coder')
    hub.setNetwork(view({ connected: false }))
    expect(sendRemote('planner@bob', 'later').last()).toMatchObject({ type: 'sent', pushed: false })
    const link = new FakeLink()
    hub.attachLink(link)
    expect(link.msgs().map(m => m.text)).toEqual(['later'])
  })

  it('puts the message back at the head when the link drops, and resends on reattach', () => {
    const { ready, hub, sendRemote } = setup()
    const { link } = ready()
    sendRemote('planner@bob', 'held')
    hub.disconnect(link)
    const again = new FakeLink()
    hub.attachLink(again)
    expect(again.msgs().map(m => m.text)).toEqual(['held'])
  })

  it('waits for pumpRemoteAll after linkRetry', () => {
    const { ready, hub, sendRemote } = setup()
    const { link } = ready()
    sendRemote('planner@bob', 'busy')
    hub.linkRetry('planner@bob', 'm1')
    expect(link.msgs()).toHaveLength(1)
    hub.pumpRemoteAll()
    expect(link.msgs().map(m => m.text)).toEqual(['busy', 'busy'])
  })

  it('ignores an ack for a message it did not hand out', () => {
    const { ready, hub, sendRemote, store } = setup()
    ready()
    sendRemote('planner@bob', 'x')
    hub.linkAck('planner@bob', 'nope')
    expect(store.queues.get('planner@bob')).toHaveLength(1)
  })

  it('does not let a local ack touch the outbox', () => {
    const { ready, call, sendRemote, store } = setup()
    ready()
    sendRemote('planner@bob', 'x')
    call({ op: 'ack', as: 'coder', id: 'm1' })
    expect(store.queues.get('planner@bob')).toHaveLength(1)
  })

  it('restores the outbox from the store after a restart', () => {
    const store = memoryStore()
    const first = setup(store)
    first.ready()
    first.sendRemote('planner@bob', 'survives')
    const second = setup(store)
    second.hub.setNetwork(view())
    const link = new FakeLink()
    second.hub.attachLink(link)
    expect(link.msgs().map(m => m.text)).toEqual(['survives'])
  })

  it('drops a member outbox when the member is removed', () => {
    const { ready, hub, sendRemote, store, logs } = setup()
    ready()
    sendRemote('planner@bob', 'x')
    hub.dropRemote('bob', 'removed from the network')
    expect(store.queues.has('planner@bob')).toBe(false)
    expect(logs.join('\n')).toMatch(/dropped 1 outbox message\(s\) for bob/)
  })

  it('drops the whole outbox when the network ends, and tells each sender', () => {
    const { ready, hub, sendRemote, store, logs } = setup()
    const { coder } = ready()
    const carol = { handle: 'carol', keyVerified: false, blocked: false, peers: [{ name: 'reviewer', kind: 'claude' as const, online: true }] }
    hub.setNetwork(view({ members: [...view().members, carol] }))
    sendRemote('planner@bob', 'one')
    sendRemote('planner@bob', 'two')
    sendRemote('reviewer@carol', 'three')
    hub.dropRemote(undefined, 'you left the network')
    expect([...store.queues.keys()].filter(k => k.includes('@'))).toEqual([])
    // Each notice is either handed to coder's listener already or still queued for it.
    const notices = new Set([...coder.msgs(), ...(store.queues.get('coder') ?? [])].filter(m => /was not delivered: you left the network/.test(m.text)).map(m => m.id))
    expect(notices.size).toBe(3)
    expect(logs.join('\n')).toMatch(/dropped 3 outbox message\(s\): you left the network/)
  })

  it('prunes an outbox head older than a week on the next claim', () => {
    const { ready, hub, sendRemote, call, advance, store } = setup()
    const { link } = ready()
    sendRemote('planner@bob', 'stale')
    hub.disconnect(link)
    advance(8 * 24 * 3600_000)
    call({ op: 'claim', folder: '/x', kind: 'claude', session: 'sess-new' })
    expect(store.queues.has('planner@bob')).toBe(false)
  })
})

describe('network: inbound', () => {
  const origin = { network: 'team', member: 'bob', keyVerified: false, allow: 'ask' as const }
  const inbound = (to: string, text = 'PAPAYA') => ({ fromAgent: 'planner', member: 'bob', to, text, origin })

  it('delivers to a shared peer, marked with its origin', () => {
    const { ready, hub } = setup()
    const { coder } = ready()
    expect(hub.inbound(inbound('coder'))).toBe('stored')
    expect(coder.msgs()).toMatchObject([{ from: 'planner@bob', to: 'coder', text: 'PAPAYA', verified: false, origin }])
  })

  it('refuses an unshared or unknown peer with the same answer', () => {
    const { ready, hub, listen } = setup()
    ready()
    listen('private', 'sess-p')
    const a = hub.inbound(inbound('private'))
    const b = hub.inbound(inbound('ghost'))
    expect(a).toEqual({ refused: 'not-shared' })
    expect(b).toEqual({ refused: 'not-shared' })
  })

  it('refuses a sender name that could break out of a reply command', () => {
    const { ready, hub } = setup()
    const { coder } = ready()
    for (const fromAgent of ['x" ; rm -rf ~ ; "', 'a b', 'UPPER', '']) {
      expect(hub.inbound({ ...inbound('coder'), fromAgent })).toEqual({ refused: 'invalid-sender' })
    }
    expect(hub.inbound({ ...inbound('coder'), member: 'bob$(id)' })).toEqual({ refused: 'invalid-sender' })
    expect(coder.msgs()).toEqual([])
  })

  it('refuses as busy once the peer holds the cap of network messages', () => {
    const { listen, share, hub } = setup()
    const coder = listen('coder', ALICE)
    share('coder')
    coder.closed = true
    for (let i = 0; i < REMOTE_QUEUE_CAP; i++) expect(hub.inbound(inbound('coder'))).toBe('stored')
    expect(hub.inbound(inbound('coder'))).toEqual({ refused: 'busy' })
  })

  it('queues a bridge notice for a local peer', () => {
    const { ready, hub } = setup()
    const { coder } = ready()
    hub.notify('coder', 'planner@bob could not be reached.')
    expect(coder.msgs()).toMatchObject([{ from: 'agent-bridge', verified: true, text: 'planner@bob could not be reached.' }])
  })
})

describe('network: sharing', () => {
  it('lets only the holding session share a name', () => {
    const { listen, share } = setup()
    listen('coder', ALICE)
    expect(error(share('coder', 'sess-mallory'))).toMatch(/not this session's name/)
    expect(share('coder').last()).toEqual({ type: 'ok' })
  })

  it('publishes names, kinds and online state only', () => {
    const { listen, share, hub } = setup()
    listen('coder', ALICE)
    share('coder')
    listen('private', 'sess-p')
    expect(hub.sharedPeers()).toEqual([{ name: 'coder', kind: 'claude', online: true }])
  })

  it('clears sharing when another session takes the name', () => {
    const { listen, share, hub, changes } = setup()
    listen('coder', ALICE)
    share('coder')
    const before = changes()
    listen('coder', 'sess-other')
    expect(hub.sharedPeers()).toEqual([])
    expect(changes()).toBeGreaterThan(before)
  })

  it('clears sharing on leave', () => {
    const { listen, share, hub, call } = setup()
    listen('coder', ALICE)
    share('coder')
    call({ op: 'leave', as: 'coder' })
    expect(hub.sharedPeers()).toEqual([])
  })

  it('reports a shared peer going offline', () => {
    const { listen, share, hub, changes } = setup()
    const coder = listen('coder', ALICE)
    share('coder')
    const before = changes()
    hub.disconnect(coder)
    expect(changes()).toBeGreaterThan(before)
    expect(hub.sharedPeers()).toEqual([{ name: 'coder', kind: 'claude', online: false }])
  })

  it('does not report changes for unshared peers', () => {
    const { listen, hub, changes } = setup()
    const p = listen('private', 'sess-p')
    hub.disconnect(p)
    expect(changes()).toBe(0)
  })
})

describe('network: status', () => {
  it('lists remote peers and the network, and never remote folders or sessions', () => {
    const { ready, sendRemote, hub, status } = setup()
    const { link } = ready()
    hub.disconnect(link)
    sendRemote('planner@bob', 'x')
    const s = status()
    expect(s.network).toEqual({ name: 'team', self: 'alice', connected: true, outbox: 1 })
    expect(s.remote).toEqual([{ address: 'planner@bob', member: 'bob', kind: 'claude', online: true, keyVerified: false, blocked: false }])
    expect(JSON.stringify(s.remote)).not.toMatch(/folder|session/)
  })

  it('shows no network section without a network', () => {
    const { status } = setup()
    expect(status().network).toBeUndefined()
    expect(status().remote).toEqual([])
  })
})
