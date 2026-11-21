import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Channel } from './channel.js'
import { b64u, dh, generateEd25519, generateX25519 } from './crypto.js'
import { verifyDirectory } from './directory.js'
import { buildJoin, buildOpen, channelFor, openJoinReply, type StaticKeys } from './handshake.js'
import { MAILBOX_MAX_ENTRIES, newHostState, ONLINE_MS, POLL_WINDOW, Relay, RPC_REPLY_PATH, type RelayStore } from './relay.js'
import { RpcReply, type Envelope, type HostState, type Invite, type Mailbox, type RpcOp } from './schema.js'
import { decodeUrlUpdate } from './url-update.js'

const HOUR = 3600_000

function memoryStore(state: HostState): RelayStore & { state: HostState; boxes: Map<string, Mailbox> } {
  const s = {
    state,
    boxes: new Map<string, Mailbox>(),
    load: () => ({ state: structuredClone(s.state), mailboxes: structuredClone(s.boxes) }),
    saveState: (st: HostState) => {
      s.state = structuredClone(st)
    },
    saveMailbox: (h: string, m: Mailbox) => {
      s.boxes.set(h, structuredClone(m))
    },
    dropMailbox: (h: string) => {
      s.boxes.delete(h)
    },
  }
  return s
}

const host: StaticKeys = { x: generateX25519(), e: generateEd25519() }
const keys = (): StaticKeys => ({ x: generateX25519(), e: generateEd25519() })

function setup(store?: ReturnType<typeof memoryStore>) {
  const clock = { now: new Date('2026-11-19T10:00:00.000Z') }
  const s = store ?? memoryStore(newHostState('team', 'alice', 'https://x.example', randomBytes))
  const woken: string[] = []
  const logs: string[] = []
  const relay = new Relay({ store: s, host, now: () => clock.now, random: randomBytes, log: m => logs.push(m), wake: h => woken.push(h) })
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }

  /** Joins with an invite. Returns the handle and the directory the host sent. */
  const join = (inv: Invite, me = keys(), handle?: string) => {
    const { req, replyKey } = buildJoin({ me, netId: inv.netId, hostX: b64u.decode(inv.hx), token: inv.token, handle, salt: randomBytes(16) })
    const r = relay.join(req)
    if (!r.ok) return undefined
    return { me, ...openJoinReply(replyKey, r.c) }
  }

  const session = (me: StaticKeys, handle: string): { sid: string; ch: Channel } => {
    const csid = randomBytes(16)
    const r = relay.open(buildOpen({ me: me.x, netId: relay.netId, hostX: host.x.pub, csid, now: clock.now }))
    if (r.type !== 'ok') throw new Error(`open: ${r.type}`)
    // The member derives the same channel from its own side of the static secret.
    const ch = channelFor(dh(me.x.priv, host.x.pub), b64u.encode(csid), r.hsid, handle, 'member')
    return { sid: ch.sid, ch }
  }

  /** One sealed RPC. Returns the opened reply, or 'wait' when the poll is held. */
  const rpc = (s: { sid: string; ch: Channel }, op: RpcOp): RpcReply | 'wait' | 'unauthorized' | 'bad' => {
    const r = relay.rpc(s.sid, s.ch.seal('/v1/rpc', Buffer.from(JSON.stringify(op))))
    if (r.type === 'reply') return RpcReply.parse(JSON.parse(s.ch.open(RPC_REPLY_PATH, r.frame).toString('utf8')))
    return r.type
  }

  /** A member that has joined and opened a session. */
  const member = (handle?: string) => {
    const j = join(relay.invite(HOUR, relay.url), keys(), handle)
    if (!j) throw new Error('join failed')
    return { ...j, s: session(j.me, j.handle) }
  }

  return { relay, store: s, advance, join, session, rpc, member, woken, logs, clock }
}

const env = (id = randomBytes(16)): Envelope => ({ v: 1, id: b64u.encode(id), e: b64u.encode(randomBytes(32)), c: b64u.encode(randomBytes(64)) })
const ok = (r: RpcReply | string): Extract<RpcReply, { ok: true }> => {
  if (typeof r === 'string' || !r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`)
  return r
}

describe('relay: invites and joins', () => {
  it('admits a member once per invite and hands back a signed directory', () => {
    const { relay, join } = setup()
    const inv = relay.invite(HOUR, relay.url)
    const j = join(inv, keys(), 'bob')
    expect(j?.handle).toBe('bob')
    expect(j && verifyDirectory(host.e.pub, j.directory)).toBe(true)
    expect(j?.directory.members.map(m => m.handle)).toEqual(['alice', 'bob'])
    expect(join(inv, keys())).toBeUndefined()
  })

  it('refuses an invite that reserves the host\'s own handle', () => {
    const { relay } = setup()
    expect(() => relay.invite(HOUR, relay.url, 'alice')).toThrow(/host's own handle/)
  })

  it('stores only the token hash', () => {
    const { relay, store } = setup()
    const inv = relay.invite(HOUR, relay.url)
    expect(JSON.stringify(store.state)).not.toContain(inv.token)
  })

  it('refuses an expired invite', () => {
    const { relay, join, advance } = setup()
    const inv = relay.invite(HOUR, relay.url)
    advance(HOUR + 1)
    expect(join(inv)).toBeUndefined()
  })

  it('refuses a made-up token with the same answer', () => {
    const { relay, join, logs } = setup()
    const inv = relay.invite(HOUR, relay.url)
    expect(join({ ...inv, token: b64u.encode(randomBytes(32)) })).toBeUndefined()
    expect(logs.join('\n')).toMatch(/unknown or used invite token/)
  })

  it('gives a taken or reserved-for-host handle a suffix', () => {
    const { relay, join } = setup()
    expect(join(relay.invite(HOUR, relay.url), keys(), 'bob')?.handle).toBe('bob')
    expect(join(relay.invite(HOUR, relay.url), keys(), 'bob')?.handle).toBe('bob-2')
    expect(join(relay.invite(HOUR, relay.url), keys(), 'alice')?.handle).toBe('alice-2')
    expect(join(relay.invite(HOUR, relay.url), keys())?.handle).toBe('member')
  })

  it('keeps the handle when the same key joins again', () => {
    const { relay, join } = setup()
    const me = keys()
    join(relay.invite(HOUR, relay.url), me, 'bob')
    expect(join(relay.invite(HOUR, relay.url), me, 'other')?.handle).toBe('bob')
  })

  it('lets an invite with a reserved handle replace that member\'s keys', () => {
    const { relay, join } = setup()
    const old = join(relay.invite(HOUR, relay.url), keys(), 'bob')
    const fresh = join(relay.invite(HOUR, relay.url, 'bob'), keys())
    expect(fresh?.handle).toBe('bob')
    const bob = fresh?.directory.members.find(m => m.handle === 'bob')
    expect(bob?.x).not.toBe(old && b64u.encode(old.me.x.pub))
  })

  it('tells the replaced keys they were removed when they try to open a session', () => {
    const { relay, join, clock } = setup()
    const oldKeys = keys()
    join(relay.invite(HOUR, relay.url), oldKeys, 'bob')
    join(relay.invite(HOUR, relay.url, 'bob'), keys())
    expect(relay.open(buildOpen({ me: oldKeys.x, netId: relay.netId, hostX: host.x.pub, csid: randomBytes(16), now: clock.now })).type).toBe('revoked')
  })
})

describe('relay: sessions', () => {
  it('opens a session for a member and refuses strangers', () => {
    const { relay, member, clock } = setup()
    member('bob')
    const stranger = keys()
    expect(relay.open(buildOpen({ me: stranger.x, netId: relay.netId, hostX: host.x.pub, csid: randomBytes(16), now: clock.now })).type).toBe('refused')
    expect(relay.open({ junk: true }).type).toBe('refused')
  })

  it('refuses an RPC on an unknown session', () => {
    const { rpc, member } = setup()
    const bob = member('bob')
    expect(rpc({ sid: 'nope', ch: bob.s.ch }, { op: 'poll', cursor: 0, epoch: 0, waitMs: 0 })).toBe('unauthorized')
  })

  it('rejects a tampered or replayed frame, and drops the session after ten', () => {
    const { relay, member, rpc } = setup()
    const bob = member('bob')
    const frame = bob.s.ch.seal('/v1/rpc', Buffer.from(JSON.stringify({ op: 'ack', upTo: 0 })))
    expect(relay.rpc(bob.s.sid, frame).type).toBe('reply')
    expect(relay.rpc(bob.s.sid, frame).type).toBe('bad')
    for (let i = 0; i < 9; i++) relay.rpc(bob.s.sid, { n: 999 + i, c: 'AAAA' })
    expect(rpc(bob.s, { op: 'ack', upTo: 0 })).toBe('unauthorized')
  })

  it('keeps at most four sessions per member', () => {
    const { member, session, rpc } = setup()
    const bob = member('bob')
    const extra = [1, 2, 3, 4].map(() => session(bob.me, 'bob'))
    expect(rpc(bob.s, { op: 'ack', upTo: 0 })).toBe('unauthorized')
    expect(ok(rpc(extra[3] ?? bob.s, { op: 'ack', upTo: 0 })).ok).toBe(true)
  })
})

describe('relay: mail', () => {
  const poll = { op: 'poll' as const, cursor: 0, epoch: 0, waitMs: 0 }

  it('routes an envelope to the recipient mailbox and wakes it', () => {
    const { member, rpc, woken } = setup()
    const bob = member('bob')
    const carol = member('carol')
    const e = env()
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: e }))
    expect(woken).toContain('carol')
    const got = ok(rpc(carol.s, poll))
    expect(got.mail).toMatchObject([{ seq: 1, from: 'bob', t: 'msg', env: e }])
  })

  it('takes the sender from the session, never from the request', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    const carol = member('carol')
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    expect(ok(rpc(carol.s, poll)).mail[0]?.from).toBe('bob')
  })

  it('stores a retried send once', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    const carol = member('carol')
    const e = env()
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: e }))
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: e }))
    expect(ok(rpc(carol.s, poll)).mail).toHaveLength(1)
  })

  it('replays from the cursor until acked, then not', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    const carol = member('carol')
    for (let i = 0; i < 3; i++) ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    expect(ok(rpc(carol.s, { ...poll, cursor: 1 })).mail.map(m => m.seq)).toEqual([2, 3])
    ok(rpc(carol.s, { op: 'ack', upTo: 2 }))
    expect(ok(rpc(carol.s, poll)).mail.map(m => m.seq)).toEqual([3])
  })

  it('hands out at most a window of entries per poll', () => {
    const { member, rpc, relay } = setup()
    const bob = member('bob')
    member('carol')
    for (let i = 0; i < POLL_WINDOW + 5; i++) ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    const r = relay.pollNow('carol', { cursor: 0, epoch: relay.directory().epoch })
    expect(r && ok(r).mail).toHaveLength(POLL_WINDOW)
  })

  it('keeps only the latest presence from a sender', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    const carol = member('carol')
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'presence', env: env() }))
    const last = env()
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'presence', env: last }))
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    const mail = ok(rpc(carol.s, poll)).mail
    expect(mail.filter(m => m.t === 'presence').map(m => m.env)).toEqual([last])
    expect(mail).toHaveLength(2)
  })

  it('refuses an unknown recipient', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    expect(rpc(bob.s, { op: 'send', to: 'ghost', t: 'msg', env: env() })).toEqual({ ok: false, error: 'unknown-member' })
  })

  it('rate-limits a burst and says when to retry', () => {
    const { member, rpc } = setup()
    const bob = member('bob')
    member('carol')
    const results = Array.from({ length: 60 }, () => rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    const limited = results.filter(r => typeof r !== 'string' && !r.ok)
    expect(limited.length).toBeGreaterThan(0)
    expect(limited[0]).toMatchObject({ ok: false, error: 'rate', retryAfterMs: expect.any(Number) })
  })

  it('refuses more mail once a mailbox is full', () => {
    const { member, rpc, advance } = setup()
    const bob = member('bob')
    member('carol')
    for (let i = 0; i < MAILBOX_MAX_ENTRIES; i++) {
      advance(200)
      ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    }
    advance(200)
    expect(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() })).toMatchObject({ ok: false, error: 'mailbox-full' })
  })

  it('holds a poll with nothing new, and answers it once mail arrives', () => {
    const { relay, member, rpc } = setup()
    const bob = member('bob')
    const carol = member('carol')
    const epoch = relay.directory().epoch
    const held = relay.rpc(carol.s.sid, carol.s.ch.seal('/v1/rpc', Buffer.from(JSON.stringify({ op: 'poll', cursor: 0, epoch, waitMs: 25_000 }))))
    expect(held.type).toBe('wait')
    if (held.type !== 'wait') return
    ok(rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    const frame = relay.answer(carol.s.sid, held.op)
    expect(frame).toBeDefined()
    if (!frame) return
    expect(ok(RpcReply.parse(JSON.parse(carol.s.ch.open(RPC_REPLY_PATH, frame).toString('utf8')))).mail).toHaveLength(1)
  })

  it('sends a fresh directory when the member holds another epoch', () => {
    const { relay, member, rpc } = setup()
    const bob = member('bob')
    const r = ok(rpc(bob.s, { op: 'poll', cursor: 0, epoch: 0, waitMs: 0 }))
    expect(r.directory?.epoch).toBe(relay.directory().epoch)
    expect(ok(rpc(bob.s, { op: 'poll', cursor: 0, epoch: relay.directory().epoch, waitMs: 0 })).directory).toBeUndefined()
  })

  it('keeps mailbox numbering across a restart, even when empty', () => {
    const first = setup()
    const bob = first.member('bob')
    const carol = first.member('carol')
    ok(first.rpc(bob.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    ok(first.rpc(carol.s, { op: 'ack', upTo: 1 }))
    const second = setup(first.store)
    expect(second.store.boxes.get('carol')).toEqual({ seq: 1, entries: [] })
    const bob2 = { s: second.session(bob.me, 'bob') }
    ok(second.rpc(bob2.s, { op: 'send', to: 'carol', t: 'msg', env: env() }))
    expect(second.store.boxes.get('carol')?.entries[0]?.seq).toBe(2)
  })

  it('serves the host\'s own member in process', () => {
    const { relay, member, rpc } = setup()
    const bob = member('bob')
    ok(rpc(bob.s, { op: 'send', to: 'alice', t: 'msg', env: env() }))
    const r = relay.localOp({ op: 'poll', cursor: 0, epoch: 0, waitMs: 0 })
    expect('reply' in r && r.reply.ok && r.reply.mail).toHaveLength(1)
  })
})

describe('relay: membership', () => {
  it('kicks a member: sessions end, the key cannot reopen or rejoin, the handle is never reused', () => {
    const { relay, member, rpc, join, clock } = setup()
    const bob = member('bob')
    expect(relay.kick('bob')).toBe(true)
    expect(rpc(bob.s, { op: 'ack', upTo: 0 })).toBe('unauthorized')
    expect(relay.open(buildOpen({ me: bob.me.x, netId: relay.netId, hostX: host.x.pub, csid: randomBytes(16), now: clock.now })).type).toBe('revoked')
    expect(join(relay.invite(HOUR, relay.url), bob.me)).toBeUndefined()
    expect(join(relay.invite(HOUR, relay.url), keys(), 'bob')?.handle).toBe('bob-2')
    expect(relay.directory().members.map(m => m.handle)).not.toContain('bob')
  })

  it('lets the host re-admit a removed handle on purpose', () => {
    const { relay, member, join } = setup()
    member('bob')
    relay.kick('bob')
    expect(join(relay.invite(HOUR, relay.url, 'bob'), keys())?.handle).toBe('bob')
  })

  it('lets a member leave without banning its key: the same key rejoins under the same handle', () => {
    const { relay, member, rpc, join } = setup()
    const bob = member('bob')
    ok(rpc(bob.s, { op: 'leave' }))
    expect(relay.members().map(m => m.handle)).toEqual(['alice'])
    expect(join(relay.invite(HOUR, relay.url), keys(), 'bob')?.handle).toBe('bob-2')
    expect(join(relay.invite(HOUR, relay.url), bob.me, 'other')?.handle).toBe('bob')
  })

  it('tells a kicked key with a live invite that it was removed, but a bad token learns nothing', () => {
    const { relay, member } = setup()
    const bob = member('bob')
    relay.kick('bob')
    const live = relay.invite(HOUR, relay.url)
    const attempt = (token: string): ReturnType<Relay['join']> =>
      relay.join(buildJoin({ me: bob.me, netId: relay.netId, hostX: host.x.pub, token, handle: 'bob', salt: randomBytes(16) }).req)
    expect(attempt(live.token)).toEqual({ ok: false, revoked: true })
    expect(attempt(b64u.encode(randomBytes(32)))).toEqual({ ok: false })
  })

  it('gives a departed member\'s handle to new keys only through a reserved invite', () => {
    const { relay, member, rpc, join } = setup()
    const bob = member('bob')
    ok(rpc(bob.s, { op: 'leave' }))
    expect(join(relay.invite(HOUR, relay.url, 'bob'), keys())?.handle).toBe('bob')
    // The old key no longer has a claim on the handle.
    expect(join(relay.invite(HOUR, relay.url), bob.me, 'bob')?.handle).toBe('bob-2')
  })

  it('marks members online after a request and offline after a quiet minute', () => {
    const { relay, member, advance } = setup()
    member('bob')
    expect(relay.members().find(m => m.handle === 'bob')?.online).toBe(true)
    advance(ONLINE_MS + 1)
    relay.tick()
    expect(relay.members().find(m => m.handle === 'bob')?.online).toBe(false)
    expect(relay.directory().members.find(m => m.handle === 'bob')?.online).toBe(false)
  })

  it('lists fingerprints, the host first', () => {
    const { relay, member } = setup()
    member('bob')
    const list = relay.members()
    expect(list.map(m => [m.handle, m.host])).toEqual([['alice', true], ['bob', false]])
    expect(list[1]?.fingerprint).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
  })
})

describe('relay: address changes', () => {
  it('signs an update a guest can check, and bumps the directory', () => {
    const { relay } = setup()
    const before = relay.directory()
    const { changed, update } = relay.setUrl('https://new.example')
    expect(changed).toBe(true)
    expect(relay.directory().url).toBe('https://new.example')
    expect(relay.directory().epoch).toBeGreaterThan(before.epoch)
    expect(decodeUrlUpdate(update, { hostEPub: host.e.pub, netId: relay.netId, lastSeq: before.urlSeq })).toMatchObject({ ok: true, update: { url: 'https://new.example', seq: 2 } })
  })

  it('does nothing for the same address', () => {
    const { relay } = setup()
    expect(relay.setUrl(relay.url).changed).toBe(false)
    expect(relay.moved).toBe(false)
  })

  it('counts as moved only once the address changed', () => {
    const { relay } = setup()
    expect(relay.moved).toBe(false)
    relay.setUrl('https://new.example')
    expect(relay.moved).toBe(true)
  })
})
