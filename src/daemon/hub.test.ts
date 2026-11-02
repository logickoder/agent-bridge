import { describe, expect, it } from 'vitest'
import { sessionTag } from '../names.js'
import { Hub, type Conn, type Store } from './hub.js'
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
}

function memoryStore(peers: Peer[] = [], queues = new Map<string, Message[]>()): Store & { peers: Peer[]; queues: Map<string, Message[]> } {
  const s = {
    peers,
    queues,
    load: () => ({ peers: structuredClone(s.peers), queues: structuredClone(s.queues) }),
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

type Deliver = NonNullable<ConstructorParameters<typeof Hub>[0]['deliver']>

function setup(store = memoryStore(), log: (msg: string) => void = () => {}, deliver?: Deliver) {
  let n = 0
  const clock = { now: new Date('2026-11-02T00:00:00Z') }
  const hub = new Hub({ store, now: () => clock.now, newId: () => `m${++n}`, pid: 1, log, ...(deliver ? { deliver } : {}) })
  const call = (req: Exclude<Request, { op: 'shutdown' }>, conn = new FakeConn()): FakeConn => {
    hub.handle(req, conn)
    return conn
  }
  const listen = (as: string, kind: 'claude' | 'agy', session?: string, stream = false) =>
    call({ op: 'listen', as, kind, stream, ...(session ? { session } : {}) })
  const send = (to: string, text: string, from = 'shell') => call({ op: 'send', from, to, text })
  const ack = (as: string, conn: FakeConn) => {
    const r = conn.replies.find(x => x.type === 'msg')
    if (r?.type !== 'msg') throw new Error('no message to ack')
    call({ op: 'ack', as, id: r.msg.id })
  }
  const claim = (folder: string, kind: 'claude' | 'agy', session: string): string => {
    const r = call({ op: 'claim', folder, kind, session }).last()
    if (r?.type !== 'claimed') throw new Error(`claim failed: ${JSON.stringify(r)}`)
    return r.name
  }
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }
  return { hub, store, call, listen, send, ack, claim, advance }
}

const texts = (conn: FakeConn) => conn.replies.flatMap(r => (r.type === 'msg' ? [r.msg.text] : []))

describe('send', () => {
  it('rejects an unknown peer and names the known ones', () => {
    const { listen, send } = setup()
    listen('agy', 'agy')
    const r = send('nobody', 'hi').last()
    expect(r?.type).toBe('error')
    expect(r?.type === 'error' && r.message).toMatch(/unknown peer "nobody". Known peers: agy/)
  })

  it('reports queued, not live, when another message is in flight', () => {
    const { listen, send } = setup()
    listen('agy', 'agy')
    expect(send('agy', 'first').last()).toMatchObject({ type: 'sent', live: true })
    expect(send('agy', 'second').last()).toMatchObject({ type: 'sent', live: false, queued: 2 })
  })

  it('queues for an offline peer and reports it', () => {
    const { listen, send, hub } = setup()
    listen('agy', 'agy').end()
    hub.disconnect(new FakeConn())
    const r = send('agy', 'hi').last()
    expect(r).toEqual({ type: 'sent', id: 'm1', live: false, pushed: false, queued: 1, listening: [] })
  })
})

describe('delivery', () => {
  it('hands a message to a waiting listener and removes it on ack', () => {
    const { listen, send, ack, store } = setup()
    const l = listen('agy', 'agy', 's1')
    expect(send('agy', 'hello').last()).toMatchObject({ live: true })
    expect(texts(l)).toEqual(['hello'])
    expect(store.queues.get('agy')).toHaveLength(1)
    ack('agy', l)
    expect(store.queues.get('agy')).toHaveLength(0)
    expect(l.closed).toBe(true)
  })

  it('puts the message back when the listener drops before ack', () => {
    const { hub, listen, send } = setup()
    const l1 = listen('agy', 'agy', 's1')
    send('agy', 'keep')
    l1.closed = true
    hub.disconnect(l1)
    const l2 = listen('agy', 'agy', 's1')
    expect(texts(l2)).toEqual(['keep'])
  })

  it('keeps order, one message in flight at a time', () => {
    const { listen, send, ack } = setup()
    listen('agy', 'agy', 's1').end()
    for (const t of ['a', 'b', 'c']) send('agy', t)
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const l = listen('agy', 'agy', 's1')
      seen.push(...texts(l))
      ack('agy', l)
    }
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('keeps a stream subscriber open across messages', () => {
    const { listen, send, ack } = setup()
    const c = listen('claude', 'claude', 'c1', true)
    send('claude', 'one')
    ack('claude', c)
    send('claude', 'two')
    expect(texts(c)).toEqual(['one', 'two'])
    expect(c.closed).toBe(false)
  })

  it('restores queues and bindings from the store', () => {
    const first = setup()
    first.listen('agy', 'agy', 's1').end()
    first.hub.disconnect(new FakeConn())
    first.send('agy', 'persisted')
    const second = setup(first.store)
    expect(second.hub.status()).toEqual([expect.objectContaining({ name: 'agy', session: 's1', queued: 1 })])
  })
})

describe('names', () => {
  it('refuses a name held by another kind', () => {
    const { listen } = setup()
    listen('lead', 'claude', 'c1', true)
    expect(listen('lead', 'agy', 's1').last()).toMatchObject({ type: 'error', message: expect.stringMatching(/taken by a claude peer/) })
  })

  it('routes by name between several peers', () => {
    const { listen, send } = setup()
    const a = listen('agy-a', 'agy', 'sa')
    const b = listen('agy-b', 'agy', 'sb')
    send('agy-b', 'for b')
    expect(texts(a)).toEqual([])
    expect(texts(b)).toEqual(['for b'])
  })
})

describe('binding', () => {
  it('binds to the newest session and wakes the old listener', () => {
    const { listen, send, hub } = setup()
    const old = listen('agy', 'agy', 's1')
    const next = listen('agy', 'agy', 's2')
    expect(old.last()).toEqual({ type: 'superseded', by: sessionTag('s2') })
    expect(old.closed).toBe(true)
    send('agy', 'for s2')
    expect(texts(next)).toEqual(['for s2'])
    expect(hub.status()[0]?.session).toBe('s2')
  })

  it('refuses an untagged listener while bound', () => {
    const { listen } = setup()
    listen('agy', 'agy', 's1')
    expect(listen('agy', 'agy').last()).toMatchObject({ type: 'error', message: expect.stringMatching(new RegExp(`bound to session ${sessionTag('s1')}`)) })
  })

  it('serves untagged listeners while unbound', () => {
    const { listen, send } = setup()
    const l = listen('agy', 'agy')
    send('agy', 'hi')
    expect(texts(l)).toEqual(['hi'])
  })

  it('drains only for the bound session, skipping the in-flight head', () => {
    const { listen, send, call } = setup()
    const l = listen('agy', 'agy', 's1')
    send('agy', 'held')
    send('agy', 'queued')
    expect(call({ op: 'drain', session: 'other' }).last()).toEqual({ type: 'drained', msgs: [], rejoin: false })
    const r = call({ op: 'drain', session: 's1' }).last()
    expect(r?.type === 'drained' && r.msgs.map(m => m.text)).toEqual(['queued'])
    expect(texts(l)).toEqual(['held'])
  })

  it('drains every peer bound to the session', () => {
    const { listen, send, call } = setup()
    listen('agy-a', 'agy', 's1').end()
    listen('agy-b', 'agy', 's1').end()
    send('agy-a', 'a')
    send('agy-b', 'b')
    const r = call({ op: 'drain', session: 's1' }).last()
    expect(r?.type === 'drained' && r.msgs.map(m => m.to)).toEqual(['agy-a', 'agy-b'])
  })

  it('keeps drained messages queued until the drain is acked', () => {
    const { listen, send, call, hub } = setup()
    listen('agy', 'agy', 's1').end()
    send('agy', 'one')
    const r = call({ op: 'drain', session: 's1' }).last()
    const ids = r?.type === 'drained' ? r.msgs.map(m => m.id) : []
    expect(ids).toHaveLength(1)
    expect(hub.status()[0]?.queued).toBe(1)
    call({ op: 'ack-drained', session: 's1', ids })
    expect(hub.status()[0]?.queued).toBe(0)
  })

  it('ignores a drain ack from another session', () => {
    const { listen, send, call, hub } = setup()
    listen('agy', 'agy', 's1').end()
    send('agy', 'one')
    const r = call({ op: 'drain', session: 's1' }).last()
    const ids = r?.type === 'drained' ? r.msgs.map(m => m.id) : []
    call({ op: 'ack-drained', session: 'other', ids })
    expect(hub.status()[0]?.queued).toBe(1)
  })

  it('supersedes a streaming listener once its in-flight message is acked', () => {
    const { listen, send, ack, hub } = setup()
    const old = listen('lead', 'claude', 'c1', true)
    send('lead', 'held')
    const next = listen('lead', 'claude', 'c2', true)
    expect(old.closed).toBe(false)
    ack('lead', old)
    expect(old.last()).toEqual({ type: 'superseded', by: sessionTag('c2') })
    expect(old.closed).toBe(true)
    expect(hub.status()[0]).toMatchObject({ session: 'c2', online: true })
    expect(next.closed).toBe(false)
  })

  it('leave unbinds and stops listeners without a re-arm', () => {
    const { listen, call, hub } = setup()
    const l = listen('agy', 'agy', 's1')
    call({ op: 'leave', as: 'agy' })
    expect(l.last()).toEqual({ type: 'stopped' })
    expect(hub.status()[0]).toMatchObject({ session: null, online: false })
  })
})

const HOUR = 3600_000

describe('claim', () => {
  it('gives a new session the base name, bound to it', () => {
    const { claim, hub } = setup()
    expect(claim('/x/b', 'agy', 's1')).toBe('b-agy')
    expect(hub.status()[0]).toMatchObject({ name: 'b-agy', kind: 'agy', session: 's1' })
  })

  it('returns the same name to the same session', () => {
    const { claim } = setup()
    claim('/x/b', 'agy', 's1')
    expect(claim('/x/b', 'agy', 's1')).toBe('b-agy')
  })

  it('never reuses a name held by another session, even an offline one', () => {
    const { claim } = setup()
    claim('/x/b', 'agy', 's1')
    expect(claim('/x/b', 'agy', 's2')).toBe('b-agy-2')
    expect(claim('/x/b', 'agy', 's3')).toBe('b-agy-3')
  })

  it('does not supersede the session that holds the base', () => {
    const { claim, listen } = setup()
    claim('/x/b', 'agy', 's1')
    const l = listen('b-agy', 'agy', 's1')
    claim('/x/b', 'agy', 's2')
    expect(l.closed).toBe(false)
  })
})

describe('pruning', () => {
  it('drops an idle peer with an empty queue after 24 hours and frees its name', () => {
    const { claim, advance, hub } = setup()
    claim('/x/b', 'agy', 's1')
    advance(25 * HOUR)
    expect(claim('/x/b', 'agy', 's2')).toBe('b-agy')
    expect(hub.status().map(p => p.session)).toEqual(['s2'])
  })

  it('keeps a peer with queued messages', () => {
    const { claim, advance, send } = setup()
    claim('/x/b', 'agy', 's1')
    send('b-agy', 'waiting')
    advance(25 * HOUR)
    expect(claim('/x/b', 'agy', 's2')).toBe('b-agy-2')
  })

  it('keeps a peer that was active recently', () => {
    const { claim, advance, listen } = setup()
    claim('/x/b', 'agy', 's1')
    advance(23 * HOUR)
    listen('b-agy', 'agy', 's1').end()
    advance(2 * HOUR)
    expect(claim('/x/b', 'agy', 's2')).toBe('b-agy-2')
  })
})

describe('send to an offline peer', () => {
  it('lists who is listening, without the sender', () => {
    const { claim, listen, send } = setup()
    claim('/x/b', 'agy', 's1')
    listen('b-agy-2', 'agy', 's2')
    listen('lead', 'claude', 'c1', true)
    expect(send('b-agy', 'hi', 'lead').last()).toMatchObject({ type: 'sent', live: false, listening: ['b-agy-2'] })
  })
})

describe('lastSeen persistence', () => {
  it('writes peers at most once an hour for routine activity', () => {
    const store = memoryStore()
    let saves = 0
    const save = store.savePeers
    store.savePeers = p => {
      saves++
      save(p)
    }
    const { claim, listen, advance } = setup(store)
    claim('/x/b', 'agy', 's1')
    const before = saves
    for (let i = 0; i < 5; i++) listen('b-agy', 'agy', 's1').end()
    expect(saves).toBe(before)
    advance(2 * HOUR)
    listen('b-agy', 'agy', 's1').end()
    expect(saves).toBe(before + 1)
  })
})

describe('review fixes', () => {
  it('saves lastSeen for a peer that is active more often than hourly', () => {
    const store = memoryStore()
    const { claim, listen, advance } = setup(store)
    claim('/x/b', 'agy', 's1')
    for (let i = 0; i < 5; i++) {
      advance(HOUR / 2)
      listen('b-agy', 'agy', 's1').end()
    }
    const saved = Date.parse(store.peers[0]?.lastSeen ?? '')
    expect(saved).toBeGreaterThanOrEqual(Date.parse('2026-11-02T01:00:00Z'))
  })

  it('does not prune at startup, before listeners reconnect', () => {
    const old = '2026-10-01T00:00:00.000Z'
    const store = memoryStore([{ name: 'x-claude', kind: 'claude', session: 'c1', joinedAt: old, lastSeen: old, auto: true }])
    const { hub } = setup(store)
    expect(hub.status().map(p => p.name)).toEqual(['x-claude'])
  })

  it('refuses another session listening on an auto name instead of taking it over', () => {
    const { claim, listen, hub } = setup()
    claim('/x/b', 'agy', 's2')
    const stale = listen('b-agy', 'agy', 's1')
    expect(stale.last()).toMatchObject({ type: 'error', message: expect.stringMatching(/auto name held by another session[\s\S]*agent-bridge join/) })
    expect(hub.status()[0]?.session).toBe('s2')
  })

  it('prunes a peer idle for 7 days even with messages queued, and logs it', () => {
    const logs: string[] = []
    const { claim, send, advance, call } = setup(memoryStore(), msg => logs.push(msg))
    claim('/x/b', 'agy', 's1')
    send('b-agy', 'never read')
    advance(8 * 24 * HOUR)
    const r = call({ op: 'claim', folder: '/x/b', kind: 'agy', session: 's2' }).last()
    expect(r).toEqual({ type: 'claimed', name: 'b-agy' })
    expect(logs.join('\n')).toMatch(/pruned b-agy.*1 queued message/)
  })

  it('gives a session its name back after it left', () => {
    const { claim, call } = setup()
    claim('/x/b', 'agy', 's1')
    call({ op: 'leave', as: 'b-agy' })
    expect(claim('/x/b', 'agy', 's1')).toBe('b-agy')
  })

  it('fails a claim cleanly when every suffix is taken', () => {
    const peers = Array.from({ length: 999 }, (_, i) => ({
      name: i === 0 ? 'b-agy' : `b-agy-${i + 1}`,
      kind: 'agy' as const,
      session: `s${i}`,
      joinedAt: '2026-11-02T00:00:00.000Z',
    }))
    const { call } = setup(memoryStore(peers))
    expect(call({ op: 'claim', folder: '/x/b', kind: 'agy', session: 'new' }).last()).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/no free name left for b-agy/),
    })
  })
})

describe('listen by session', () => {
  const bySession = (session: string, kind: 'claude' | 'agy' = 'claude', stream = true) =>
    ({ op: 'listen', kind, session, stream }) as const

  it('attaches to the name already bound to the session', () => {
    const { claim, call, send } = setup()
    claim('/x/b', 'claude', 'c1')
    const l = call(bySession('c1'))
    send('b-claude', 'hi')
    expect(texts(l)).toEqual(['hi'])
  })

  it('waits for join when no name is bound yet, then attaches', () => {
    const { claim, call, send } = setup()
    const l = call(bySession('c1'))
    expect(l.replies).toEqual([])
    expect(l.closed).toBe(false)
    claim('/x/b', 'claude', 'c1')
    send('b-claude', 'after join')
    expect(texts(l)).toEqual(['after join'])
  })

  it('binds an explicit name from join and attaches a waiting listener to it', () => {
    const { call, send, hub } = setup()
    const l = call(bySession('c1'))
    expect(call({ op: 'claim', kind: 'claude', session: 'c1', name: 'reviewer' }).last()).toEqual({ type: 'claimed', name: 'reviewer' })
    expect(hub.status()[0]).toMatchObject({ name: 'reviewer', session: 'c1' })
    send('reviewer', 'review this')
    expect(texts(l)).toEqual(['review this'])
  })

  it('refuses an explicit join on an auto name held by another session', () => {
    const { claim, call } = setup()
    claim('/x/b', 'claude', 'c1')
    expect(call({ op: 'claim', kind: 'claude', session: 'c2', name: 'b-claude' }).last()).toMatchObject({ type: 'error' })
  })

  it('refuses a second stream listener for the same session', () => {
    const { claim, call } = setup()
    claim('/x/b', 'claude', 'c1')
    const first = call(bySession('c1'))
    const second = call(bySession('c1'))
    expect(second.last()).toMatchObject({ type: 'error', message: expect.stringMatching(/already receives/) })
    expect(first.closed).toBe(false)
  })

  it('drops a waiting listener that disconnects before join', () => {
    const { call, hub, claim } = setup()
    const l = call(bySession('c1'))
    l.end()
    hub.disconnect(l)
    claim('/x/b', 'claude', 'c1')
    expect(hub.status()[0]?.online).toBe(false)
  })
})

describe('rename', () => {
  const bySession = (session: string) => ({ op: 'listen', kind: 'claude', session, stream: true }) as const

  it('renames the session peer in place, keeping its listener and queue', () => {
    const { claim, call, send, hub } = setup()
    claim('/x/b', 'claude', 'c1')
    const l = call(bySession('c1'))
    send('b-claude', 'before')
    call({ op: 'claim', kind: 'claude', session: 'c1', name: 'reviewer' })
    expect(hub.status().map(p => p.name)).toEqual(['reviewer'])
    send('reviewer', 'after')
    expect(l.closed).toBe(false)
    expect(texts(l)).toEqual(['before'])
    call({ op: 'ack', as: 'reviewer', id: 'm1' })
    expect(texts(l)).toEqual(['before', 'after'])
  })

  it('moves the listener to an existing name and releases the old one', () => {
    const { claim, call, send, hub, listen } = setup()
    listen('reviewer', 'claude').end()
    claim('/x/b', 'claude', 'c1')
    const l = call(bySession('c1'))
    call({ op: 'claim', kind: 'claude', session: 'c1', name: 'reviewer' })
    send('reviewer', 'to the role')
    expect(texts(l)).toEqual(['to the role'])
    expect(hub.status().find(p => p.name === 'b-claude')).toMatchObject({ session: null, online: false })
  })

  it('makes the renamed peer explicit, so its name is no longer locked to the session', () => {
    const { claim, call, hub } = setup()
    claim('/x/b', 'claude', 'c1')
    call({ op: 'claim', kind: 'claude', session: 'c1', name: 'reviewer' })
    expect(hub.status()[0]?.auto).toBeFalsy()
  })
})

describe('push endpoints', () => {
  /** A deliver function whose calls resolve or fail when the test says so. */
  function pushRecorder() {
    const calls: { kind: string; endpoint: Record<string, string>; text: string; settle: (ok: boolean) => void }[] = []
    const deliver: Deliver = (kind, endpoint, msg) =>
      new Promise((resolve, reject) => {
        calls.push({ kind, endpoint, text: msg.text, settle: ok => (ok ? resolve() : reject(new Error('agentapi failed'))) })
      })
    return { calls, deliver }
  }
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('delivers through the endpoint and dequeues on success', async () => {
    const rec = pushRecorder()
    const { claim, call, send, hub } = setup(memoryStore(), () => {}, rec.deliver)
    claim('/x/b', 'agy', 's1')
    expect(call({ op: 'push', kind: 'agy', session: 's1', endpoint: { conversation: 's1' } }).last()).toEqual({ type: 'ok' })
    expect(send('b-agy', 'hi').last()).toMatchObject({ type: 'sent', live: false, pushed: true })
    expect(rec.calls.map(c => [c.kind, c.text])).toEqual([['agy', 'hi']])
    rec.calls[0]?.settle(true)
    await flush()
    expect(hub.status()[0]).toMatchObject({ queued: 0, online: true })
  })

  it('keeps the message and drops the endpoint when delivery fails', async () => {
    const rec = pushRecorder()
    const { claim, call, send, hub } = setup(memoryStore(), () => {}, rec.deliver)
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    send('b-agy', 'hi')
    rec.calls[0]?.settle(false)
    await flush()
    expect(hub.status()[0]).toMatchObject({ queued: 1, online: false })
  })

  it('replaces the endpoint when the session registers again', async () => {
    const rec = pushRecorder()
    const { claim, call, send } = setup(memoryStore(), () => {}, rec.deliver)
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: { address: 'old' } })
    expect(call({ op: 'push', kind: 'agy', session: 's1', endpoint: { address: 'new' } }).last()).toEqual({ type: 'ok' })
    send('b-agy', 'hi')
    expect(rec.calls.map(c => c.endpoint['address'])).toEqual(['new'])
  })

  it('follows a rename', () => {
    const rec = pushRecorder()
    const { claim, call, send } = setup(memoryStore(), () => {}, rec.deliver)
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    call({ op: 'claim', kind: 'agy', session: 's1', name: 'planner' })
    send('planner', 'renamed')
    expect(rec.calls.map(c => c.text)).toEqual(['renamed'])
  })

  it('never shows the endpoint in status', () => {
    const rec = pushRecorder()
    const { claim, call, hub } = setup(memoryStore(), () => {}, rec.deliver)
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: { token: 'secret' } })
    expect(JSON.stringify(hub.status())).not.toContain('secret')
  })
})

describe('rejoin hint', () => {
  const drain = (call: ReturnType<typeof setup>['call'], session: string) => call({ op: 'drain', session }).last()

  it('asks a bound session without a push endpoint to rejoin, once per daemon run', () => {
    const { claim, call } = setup()
    claim('/x/b', 'agy', 's1')
    expect(drain(call, 's1')).toMatchObject({ type: 'drained', rejoin: true })
    expect(drain(call, 's1')).toMatchObject({ type: 'drained', rejoin: false })
  })

  it('does not ask a session that has a push endpoint, or one bound to nothing', () => {
    const { claim, call } = setup(memoryStore(), () => {}, async () => {})
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    expect(drain(call, 's1')).toMatchObject({ rejoin: false })
    expect(drain(call, 'nobody')).toMatchObject({ rejoin: false })
  })
})

describe('push next to another receiver', () => {
  it('refuses a push endpoint for a session that already receives through a stream listener', () => {
    const { claim, call } = setup(memoryStore(), () => {}, async () => {})
    claim('/x/b', 'claude', 'c1')
    call({ op: 'listen', kind: 'claude', session: 'c1', stream: true })
    expect(call({ op: 'push', kind: 'claude', session: 'c1', endpoint: {} }).last()).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/already receives/),
    })
  })
})

describe('sender verification', () => {
  it('accepts a sender name held by the sending session, and marks it verified', () => {
    const { claim, call, listen } = setup()
    claim('/x/a', 'agy', 's1')
    const l = listen('b', 'agy')
    call({ op: 'send', from: 'a-agy', to: 'b', text: 'hi', sessions: ['s1'] })
    const r = l.replies.find(x => x.type === 'msg')
    expect(r?.type === 'msg' && r.msg.verified).toBe(true)
  })

  it('refuses a sender name the sending session does not hold', () => {
    const { claim, call, listen } = setup()
    claim('/x/a', 'agy', 's1')
    listen('b', 'agy')
    expect(call({ op: 'send', from: 'lead', to: 'b', text: 'hi', sessions: ['s1'] }).last()).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/not this session's name/),
    })
  })

  it('delivers a send without a session as unverified', () => {
    const { call, listen } = setup()
    const l = listen('b', 'agy')
    call({ op: 'send', from: 'shell', to: 'b', text: 'hi' })
    const r = l.replies.find(x => x.type === 'msg')
    expect(r?.type === 'msg' && r.msg.verified).toBe(false)
  })
})

describe('status redaction', () => {
  it('shows a tag, not the raw session id, in the status reply', async () => {
    const { sessionTag } = await import('../names.js')
    const { claim, call } = setup()
    claim('/x/b', 'agy', 'secret-session-id')
    call({ op: 'leave', as: 'b-agy' })
    claim('/x/c', 'agy', 'other-session')
    const r = call({ op: 'status' }).last()
    expect(JSON.stringify(r)).not.toContain('secret-session-id')
    expect(JSON.stringify(r)).not.toContain('other-session')
    expect(r?.type === 'status' && r.peers.find(p => p.name === 'c-agy')?.session).toBe(sessionTag('other-session'))
  })
})

describe('resume findings', () => {
  it('asks to rejoin again after a push endpoint is lost, even if it asked before this run', async () => {
    let fail = false
    const deliver = async () => {
      if (fail) throw new Error('exit 1')
    }
    const { claim, call, send } = setup(memoryStore(), () => {}, deliver)
    claim('/x/b', 'agy', 's1')
    expect(call({ op: 'drain', session: 's1' }).last()).toMatchObject({ rejoin: true })
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    fail = true
    send('b-agy', 'lost')
    await new Promise(r => setTimeout(r, 0))
    expect(call({ op: 'drain', session: 's1' }).last()).toMatchObject({ rejoin: true })
  })

  it('reports a message handed to a push endpoint as pushed, not live', () => {
    const { claim, call, send } = setup(memoryStore(), () => {}, () => new Promise(() => {}))
    claim('/x/b', 'agy', 's1')
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    expect(send('b-agy', 'x').last()).toMatchObject({ type: 'sent', live: false, pushed: true })
  })

  it('logs a session tag, never the raw session id', async () => {
    const logs: string[] = []
    const { claim, call, send } = setup(memoryStore(), m => logs.push(m), async () => {
      throw new Error('exit 1')
    })
    claim('/x/b', 'agy', 'raw-session-id')
    call({ op: 'push', kind: 'agy', session: 'raw-session-id', endpoint: {} })
    send('b-agy', 'x')
    await new Promise(r => setTimeout(r, 0))
    expect(logs.join('\n')).toMatch(/dropped/)
    expect(logs.join('\n')).not.toContain('raw-session-id')
  })
})

describe('taking an online name', () => {
  it('refuses an explicit name that is online in another session, and says how to take it', () => {
    const { call, listen, hub } = setup()
    const held = listen('reviewer', 'claude', 'c1', true)
    expect(call({ op: 'claim', kind: 'claude', session: 'c2', name: 'reviewer' }).last()).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/online in another session[\s\S]*--take/),
    })
    expect(held.closed).toBe(false)
    expect(hub.status().find(p => p.name === 'reviewer')?.session).toBe('c1')
  })

  it('takes over an explicit name whose holder is offline, without asking', () => {
    const { call, listen, hub } = setup()
    listen('reviewer', 'claude', 'c1', true).end()
    expect(call({ op: 'claim', kind: 'claude', session: 'c2', name: 'reviewer' }).last()).toEqual({ type: 'claimed', name: 'reviewer' })
    expect(hub.status().find(p => p.name === 'reviewer')?.session).toBe('c2')
  })

  it('takes an online name with take, and the old listener is told', () => {
    const { call, listen } = setup()
    const held = listen('reviewer', 'claude', 'c1', true)
    expect(call({ op: 'claim', kind: 'claude', session: 'c2', name: 'reviewer', take: true }).last()).toEqual({ type: 'claimed', name: 'reviewer' })
    expect(held.last()).toEqual({ type: 'superseded', by: sessionTag('c2') })
  })

  it('sends a push-mode holder a takeover notice before dropping its endpoint', async () => {
    const texts: string[] = []
    const { call } = setup(memoryStore(), () => {}, async (_kind, _endpoint, msg) => void texts.push(msg.text))
    call({ op: 'claim', kind: 'agy', session: 's1', name: 'planner' })
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    call({ op: 'claim', kind: 'agy', session: 's2', name: 'planner', take: true })
    await new Promise(r => setTimeout(r, 0))
    expect(texts.join('\n')).toMatch(/Another session took over "planner"/)
  })
})

describe('code review fixes', () => {
  it('accepts an ack under the old name after an in-place rename', () => {
    const { claim, call, send } = setup()
    claim('/x/c', 'claude', 'c1')
    const l = call({ op: 'listen', kind: 'claude', session: 'c1', stream: true })
    send('c-claude', 'first')
    send('c-claude', 'second')
    call({ op: 'claim', kind: 'claude', session: 'c1', name: 'planner' })
    call({ op: 'ack', as: 'c-claude', id: 'm1' })
    expect(texts(l)).toEqual(['first', 'second'])
  })

  it('carries the old queue over when a session moves onto an existing name', () => {
    const { claim, call, send, listen, hub } = setup()
    listen('planner', 'claude').end()
    claim('/x/c', 'claude', 'c1')
    send('c-claude', 'waiting')
    const l = call({ op: 'listen', kind: 'claude', session: 'c1', stream: true })
    call({ op: 'ack', as: 'c-claude', id: 'm1' })
    send('c-claude', 'queued 1')
    call({ op: 'claim', kind: 'claude', session: 'c1', name: 'planner' })
    expect(texts(l)).toContain('queued 1')
    expect(hub.status().find(p => p.name === 'c-claude')?.queued).toBe(0)
  })

  it('names the new holder by tag, never by raw session id, in a takeover', async () => {
    const { sessionTag } = await import('../names.js')
    const { call, listen } = setup()
    const held = listen('reviewer', 'claude', 'c1', true)
    call({ op: 'claim', kind: 'claude', session: 'raw-new-session', name: 'reviewer', take: true })
    expect(held.last()).toEqual({ type: 'superseded', by: sessionTag('raw-new-session') })
  })

  it('does not print the bound session id when refusing an untagged listener', () => {
    const { listen } = setup()
    listen('agy', 'agy', 'raw-bound-session')
    expect(JSON.stringify(listen('agy', 'agy').last())).not.toContain('raw-bound-session')
  })

  it('sends the takeover notice as a checked bridge message, stamped by the hub clock', async () => {
    const got: Message[] = []
    const { call } = setup(memoryStore(), () => {}, async (_k, _e, msg) => void got.push(msg))
    call({ op: 'claim', kind: 'agy', session: 's1', name: 'planner' })
    call({ op: 'push', kind: 'agy', session: 's1', endpoint: {} })
    call({ op: 'claim', kind: 'agy', session: 's2', name: 'planner', take: true })
    await new Promise(r => setTimeout(r, 0))
    const notice = got.find(m => m.from === 'agent-bridge')
    expect(notice).toMatchObject({ verified: true, ts: '2026-11-02T00:00:00.000Z' })
  })
})

describe('reserved bridge sender', () => {
  it('refuses to send as the bridge, and to claim or listen on its name', () => {
    const { call, listen } = setup()
    listen('b', 'agy')
    expect(call({ op: 'send', from: 'agent-bridge', to: 'b', text: 'fake notice' }).last()).toMatchObject({ type: 'error', message: expect.stringMatching(/reserved/) })
    expect(call({ op: 'claim', kind: 'agy', session: 's9', name: 'agent-bridge' }).last()).toMatchObject({ type: 'error', message: expect.stringMatching(/reserved/) })
    expect(listen('agent-bridge', 'agy').last()).toMatchObject({ type: 'error', message: expect.stringMatching(/reserved/) })
  })
})
