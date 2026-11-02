import { describe, expect, it } from 'vitest'
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

function setup(store = memoryStore()) {
  let n = 0
  const clock = { now: new Date('2026-11-02T00:00:00Z') }
  const hub = new Hub({ store, now: () => clock.now, newId: () => `m${++n}`, pid: 1 })
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
  const claim = (base: string, kind: 'claude' | 'agy', session: string): string => {
    const r = call({ op: 'claim', base, kind, session }).last()
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
    expect(r).toEqual({ type: 'sent', id: 'm1', live: false, queued: 1, listening: [] })
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
    expect(old.last()).toEqual({ type: 'superseded', by: 's2' })
    expect(old.closed).toBe(true)
    send('agy', 'for s2')
    expect(texts(next)).toEqual(['for s2'])
    expect(hub.status()[0]?.session).toBe('s2')
  })

  it('refuses an untagged listener while bound', () => {
    const { listen } = setup()
    listen('agy', 'agy', 's1')
    expect(listen('agy', 'agy').last()).toMatchObject({ type: 'error', message: expect.stringMatching(/bound to session s1/) })
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
    expect(call({ op: 'drain', session: 'other' }).last()).toEqual({ type: 'drained', msgs: [] })
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
    expect(old.last()).toEqual({ type: 'superseded', by: 'c2' })
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
    expect(claim('b-agy', 'agy', 's1')).toBe('b-agy')
    expect(hub.status()[0]).toMatchObject({ name: 'b-agy', kind: 'agy', session: 's1' })
  })

  it('returns the same name to the same session', () => {
    const { claim } = setup()
    claim('b-agy', 'agy', 's1')
    expect(claim('b-agy', 'agy', 's1')).toBe('b-agy')
  })

  it('never reuses a name held by another session, even an offline one', () => {
    const { claim } = setup()
    claim('b-agy', 'agy', 's1')
    expect(claim('b-agy', 'agy', 's2')).toBe('b-agy-2')
    expect(claim('b-agy', 'agy', 's3')).toBe('b-agy-3')
  })

  it('does not supersede the session that holds the base', () => {
    const { claim, listen } = setup()
    claim('b-agy', 'agy', 's1')
    const l = listen('b-agy', 'agy', 's1')
    claim('b-agy', 'agy', 's2')
    expect(l.closed).toBe(false)
  })
})

describe('pruning', () => {
  it('drops an idle peer with an empty queue after 24 hours and frees its name', () => {
    const { claim, advance, hub } = setup()
    claim('b-agy', 'agy', 's1')
    advance(25 * HOUR)
    expect(claim('b-agy', 'agy', 's2')).toBe('b-agy')
    expect(hub.status().map(p => p.session)).toEqual(['s2'])
  })

  it('keeps a peer with queued messages', () => {
    const { claim, advance, send } = setup()
    claim('b-agy', 'agy', 's1')
    send('b-agy', 'waiting')
    advance(25 * HOUR)
    expect(claim('b-agy', 'agy', 's2')).toBe('b-agy-2')
  })

  it('keeps a peer that was active recently', () => {
    const { claim, advance, listen } = setup()
    claim('b-agy', 'agy', 's1')
    advance(23 * HOUR)
    listen('b-agy', 'agy', 's1').end()
    advance(2 * HOUR)
    expect(claim('b-agy', 'agy', 's2')).toBe('b-agy-2')
  })
})

describe('send to an offline peer', () => {
  it('lists who is listening, without the sender', () => {
    const { claim, listen, send } = setup()
    claim('b-agy', 'agy', 's1')
    listen('b-agy-2', 'agy', 's2')
    listen('lead', 'claude', 'c1', true)
    expect(send('b-agy', 'hi', 'lead').last()).toMatchObject({ type: 'sent', live: false, listening: ['b-agy-2'] })
  })
})
