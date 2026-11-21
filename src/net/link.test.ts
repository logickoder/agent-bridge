import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hub, REMOTE_QUEUE_CAP, type Conn, type Store } from '../daemon/hub.js'
import type { Message, Peer, Reply } from '../schema.js'
import type { Channel } from './channel.js'
import { b64u, dh, fingerprint, generateEd25519, generateX25519 } from './crypto.js'
import { signDirectory } from './directory.js'
import { buildJoin, buildOpen, channelFor, memberBinding, openJoinReply, type StaticKeys } from './handshake.js'
import { allowLevel, holdCapped, Link, MAX_MESSAGE_AGE_MS, normalizeCode, outsideReplayWindow, type Transport } from './link.js'
import { newHostState, Relay, RPC_REPLY_PATH, type RelayStore } from './relay.js'
import { RpcReply, type HostState, type LinkState, type Mailbox, type MailEntry, type RpcOp } from './schema.js'
import { sealEnvelope } from './envelope.js'
import { LocalTransport } from './transport-local.js'
import { PollWaits } from './waits.js'
import { sign } from './crypto.js'

// A whole network in one process: the host (alice) with its relay, hub and link, and guests with their own.
// Real crypto, real hub, real relay. Only the HTTP hop is replaced, by calls into the relay through real channels.

const POLL_MS = 40
const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, Math.min(ms, 15)))

class Listener implements Conn {
  readonly msgs: Message[] = []
  closed = false
  send(r: Reply): void {
    if (r.type === 'msg') this.msgs.push(r.msg)
  }
  end(): void {}
}

function hubStore(): Store {
  const s = { peers: [] as Peer[], queues: new Map<string, Message[]>() }
  return {
    load: () => ({ peers: structuredClone(s.peers), queues: structuredClone(s.queues), endpoints: [] }),
    saveEndpoints: () => {},
    savePeers: p => {
      s.peers = structuredClone(p)
    },
    saveQueue: (n, m) => {
      s.queues.set(n, structuredClone(m))
    },
    dropQueue: n => {
      s.queues.delete(n)
    },
  }
}

function relayStore(state: HostState): RelayStore & { dump: () => string } {
  let st = state
  const boxes = new Map<string, Mailbox>()
  return {
    load: () => ({ state: structuredClone(st), mailboxes: structuredClone(boxes) }),
    saveState: s => {
      st = structuredClone(s)
    },
    saveMailbox: (h, m) => {
      boxes.set(h, structuredClone(m))
    },
    dropMailbox: h => {
      boxes.delete(h)
    },
    dump: () => JSON.stringify({ st, boxes: [...boxes] }),
  }
}

/** The guest's transport: open a session, then sealed RPCs. Held polls wait on the relay's wake. */
class ChannelTransport implements Transport {
  readonly urls: string[] = []
  private sess: { sid: string; ch: Channel } | undefined

  constructor(
    private readonly relay: Relay,
    private readonly waits: PollWaits,
    private readonly keys: StaticKeys,
    private readonly hostX: Uint8Array,
    private readonly handle: string,
  ) {}

  async call(op: RpcOp): Promise<RpcReply> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sess = this.sess ?? this.open()
      if (!sess) return { ok: false, error: 'revoked' }
      const r = this.relay.rpc(sess.sid, sess.ch.seal('/v1/rpc', Buffer.from(JSON.stringify(op))))
      if (r.type === 'unauthorized') {
        this.sess = undefined
        continue
      }
      if (r.type === 'bad') throw new Error('bad frame')
      if (r.type === 'reply') return this.read(sess.ch, r.frame)
      const wait = r.op
      await this.waits.hold(this.handle, wait.waitMs, () => this.relay.pollNow(this.handle, wait))
      const frame = this.relay.answer(sess.sid, wait)
      if (!frame) throw new Error('session gone')
      return this.read(sess.ch, frame)
    }
    throw new Error('host unreachable')
  }

  private read(ch: Channel, frame: { n: number; c: string }): RpcReply {
    return RpcReply.parse(JSON.parse(ch.open(RPC_REPLY_PATH, frame).toString('utf8')))
  }

  private open(): { sid: string; ch: Channel } | undefined {
    const csid = randomBytes(16)
    const r = this.relay.open(buildOpen({ me: this.keys.x, netId: this.relay.netId, hostX: this.hostX, csid, now: new Date() }))
    if (r.type !== 'ok') return undefined
    const ch = channelFor(dh(this.keys.x.priv, this.hostX), b64u.encode(csid), r.hsid, this.handle, 'member')
    this.sess = { sid: ch.sid, ch }
    return this.sess
  }

  setUrl(url: string): void {
    this.urls.push(url)
  }
}

const running: Link[] = []
afterEach(() => {
  for (const l of running.splice(0)) l.stop()
})

interface Node {
  hub: Hub
  link: Link
  keys: StaticKeys
  state: LinkState
  handle: string
  transport?: ChannelTransport
  logs: string[]
  /** A local agent: joined, listening, and shared on the network. */
  agent(name: string, share?: boolean): Listener
  send(from: string, to: string, text: string): Reply | undefined
}

function makeHub(link: () => Link): Hub {
  let n = 0
  return new Hub({ store: hubStore(), now: () => new Date(), newId: () => `m${++n}`, pid: 1, net: { changed: () => link().changed() } })
}

function node(hub: Hub, link: Link, keys: StaticKeys, state: LinkState, logs: string[], transport?: ChannelTransport): Node {
  const agent = (name: string, share = true): Listener => {
    const l = new Listener()
    hub.handle({ op: 'listen', as: name, kind: 'claude', session: `s-${name}`, stream: true }, l)
    if (share) hub.handle({ op: 'share', as: name, sessions: [`s-${name}`], on: true }, new Listener())
    return l
  }
  const send = (from: string, to: string, text: string): Reply | undefined => {
    const c = new Listener()
    const replies: Reply[] = []
    c.send = r => void replies.push(r)
    hub.handle({ op: 'send', from, to, text, sessions: [`s-${from}`] }, c)
    return replies.at(-1)
  }
  return { hub, link, keys, state, handle: state.handle, logs, agent, send, ...(transport ? { transport } : {}) }
}

function network() {
  const host: StaticKeys = { x: generateX25519(), e: generateEd25519() }
  const waits = new PollWaits(timer)
  const store = relayStore(newHostState('team', 'alice', 'https://one.example', randomBytes))
  const relay = new Relay({ store, host, now: () => new Date(), random: randomBytes, wake: h => waits.wake(h) })

  const linkDeps = (hub: Hub, transport: Transport, keys: StaticKeys, logs: string[]) => ({
    hub,
    transport,
    store: { save: () => {} },
    keys,
    now: () => new Date(),
    sleep,
    random: Math.random,
    log: (m: string) => void logs.push(m),
    pollWaitMs: POLL_MS,
  })

  const baseState = (handle: string, keys: StaticKeys): LinkState => ({
    netId: relay.netId,
    network: 'team',
    handle,
    url: relay.url,
    urlSeq: 1,
    hostE: b64u.encode(host.e.pub),
    hostX: b64u.encode(host.x.pub),
    cursor: 0,
    pins: {},
    seen: {},
    held: [],
    sent: {},
    presence: {},
    state: 'active',
  })

  const start = (link: Link): void => {
    running.push(link)
    void link.run()
  }

  /** The host's own member. */
  const hostNode = (): Node => {
    const logs: string[] = []
    const state = baseState('alice', host)
    let link: Link | undefined
    const hub = makeHub(() => {
      if (!link) throw new Error('no link yet')
      return link
    })
    link = new Link(state, linkDeps(hub, new LocalTransport(relay, waits), host, logs))
    start(link)
    return node(hub, link, host, state, logs)
  }

  /** A guest that joins with a fresh invite. `reserved`: the host re-admits this handle with new keys. */
  const guest = (wanted: string, reserved?: string): Node => {
    const keys: StaticKeys = { x: generateX25519(), e: generateEd25519() }
    const inv = relay.invite(3600_000, relay.url, reserved)
    const { req, replyKey } = buildJoin({ me: keys, netId: inv.netId, hostX: host.x.pub, token: inv.token, handle: wanted, salt: randomBytes(16) })
    const r = relay.join(req)
    if (!r.ok) throw new Error('join refused')
    const reply = openJoinReply(replyKey, r.c)
    const logs: string[] = []
    const state = baseState(reply.handle, keys)
    const transport = new ChannelTransport(relay, waits, keys, host.x.pub, reply.handle)
    let link: Link | undefined
    const hub = makeHub(() => {
      if (!link) throw new Error('no link yet')
      return link
    })
    link = new Link(state, linkDeps(hub, transport, keys, logs))
    link.applyDirectory(reply.directory)
    start(link)
    return node(hub, link, keys, state, logs, transport)
  }

  return { relay, host, store, hostNode, guest }
}

const wait = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 4000, interval: 10 })
const remoteOnline = (n: Node, address: string): Promise<void> =>
  wait(() => {
    const r = new Listener()
    const replies: Reply[] = []
    r.send = x => void replies.push(x)
    n.hub.handle({ op: 'status' }, r)
    const s = replies[0]
    expect(s?.type === 'status' && s.remote.some(p => p.address === address && p.online)).toBe(true)
  })

describe('link: messages between members', () => {
  it('carries a message from the host\'s agent to a guest\'s agent and a reply back', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    const planner = bob.agent('planner')
    await remoteOnline(alice, 'planner@bob')
    expect(alice.send('coder', 'planner@bob', 'PAPAYA-SECRET-42')).toMatchObject({ type: 'sent', via: 'network', keyVerified: false })
    await wait(() => expect(planner.msgs.map(m => m.text)).toEqual(['PAPAYA-SECRET-42']))
    expect(planner.msgs[0]).toMatchObject({ from: 'coder@alice', to: 'planner', verified: false, origin: { network: 'team', member: 'alice', keyVerified: false } })
    await remoteOnline(bob, 'coder@alice')
    bob.send('planner', 'coder@alice', 'got it')
    await wait(() => expect(coder.msgs.map(m => m.text)).toEqual(['got it']))
  })

  it('works between two guests through the host', async () => {
    const net = network()
    net.hostNode()
    const bob = net.guest('bob')
    const carol = net.guest('carol')
    bob.agent('planner')
    const tester = carol.agent('tester')
    await remoteOnline(bob, 'tester@carol')
    bob.send('planner', 'tester@carol', 'hello carol')
    await wait(() => expect(tester.msgs.map(m => m.text)).toEqual(['hello carol']))
  })

  it('never lets the host see message text or agent names', async () => {
    const net = network()
    net.hostNode()
    const bob = net.guest('bob')
    const carol = net.guest('carol')
    bob.agent('zebra-planner')
    const ocelot = carol.agent('ocelot-coder')
    await remoteOnline(bob, 'ocelot-coder@carol')
    ocelot.closed = true // hold the message at carol's side so the mailbox has had it
    bob.send('zebra-planner', 'ocelot-coder@carol', 'PAPAYA-SECRET-42')
    await wait(() => expect(net.store.dump()).toMatch(/"seq":[1-9]/))
    const dump = net.store.dump()
    for (const secret of ['PAPAYA-SECRET-42', 'zebra-planner', 'ocelot-coder']) expect(dump).not.toContain(secret)
  })

  it('bounces a message for an agent that is not shared, and tells the sender', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    bob.agent('planner')
    await remoteOnline(alice, 'planner@bob')
    bob.hub.handle({ op: 'share', as: 'planner', sessions: ['s-planner'], on: false }, new Listener())
    alice.send('coder', 'planner@bob', 'too late')
    await wait(() => expect(coder.msgs.map(m => m.text)).toEqual(['Your message to planner@bob was not delivered: "planner" is not shared on that network.']))
    expect(coder.msgs[0]?.from).toBe('agent-bridge')
  })

  it('bounces as busy for an agent at its cap, without holding up the member\'s other agents', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    const idle = bob.agent('idle')
    const planner = bob.agent('planner')
    await remoteOnline(alice, 'planner@bob')
    idle.closed = true // the agent stops reading; its messages pile up in its queue
    for (let i = 0; i < REMOTE_QUEUE_CAP + 1; i++) alice.send('coder', 'idle@bob', `n${i}`)
    // The one over the cap comes back at once instead of stalling bob's mailbox...
    await wait(() => expect(coder.msgs.map(m => m.text)).toEqual(['Your message to idle@bob was not delivered: "idle" has too many unread network messages. Send it again later.']))
    // ...so mail behind it, for bob's other agents, keeps arriving.
    alice.send('coder', 'planner@bob', 'still flowing')
    await wait(() => expect(planner.msgs.map(m => m.text)).toEqual(['still flowing']))
  }, 15_000)

  it('ignores a bounce for a message that was never sent to that member', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    await wait(() => expect(bob.state.pins['alice']).toBeDefined())
    const forged = sealEnvelope({
      netId: net.relay.netId,
      from: 'bob',
      to: 'alice',
      senderPriv: bob.keys.x.priv,
      senderPub: bob.keys.x.pub,
      recipientPub: net.host.x.pub,
      id: randomBytes(16),
      plaintext: Buffer.from(JSON.stringify({ t: 'bounce', ref: b64u.encode(randomBytes(16)), reason: 'not-shared' })),
    })
    await bob.transport?.call({ op: 'send', to: 'alice', t: 'bounce', env: forged })
    await wait(() => expect(alice.logs.join('\n')).toMatch(/dropped a bounce from bob for a message not sent to it/))
    expect(coder.msgs).toEqual([])
  })

  it('publishes only shared agents, and their online state', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    bob.agent('planner')
    bob.agent('private', false)
    await remoteOnline(alice, 'planner@bob')
    const r = new Listener()
    const replies: Reply[] = []
    r.send = x => void replies.push(x)
    alice.hub.handle({ op: 'status' }, r)
    const s = replies[0]
    expect(s?.type === 'status' && s.remote.map(p => p.address)).toEqual(['planner@bob'])
  })

  it('sends presence again only when the shared list changed', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    bob.agent('planner')
    await remoteOnline(alice, 'planner@bob')
    const transport = bob.transport
    if (!transport) throw new Error('guest has no transport')
    let presence = 0
    const call = transport.call.bind(transport)
    transport.call = op => {
      if (op.op === 'send' && op.t === 'presence') presence++
      return call(op)
    }
    bob.link.changed()
    await new Promise(r => setTimeout(r, 60))
    expect(presence).toBe(0)
    bob.agent('coder')
    await remoteOnline(alice, 'coder@bob')
    expect(presence).toBeGreaterThan(0)
  })

  it('keeps what other members share in its saved state, so a restart still knows', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    bob.agent('planner')
    await remoteOnline(alice, 'planner@bob')
    expect(alice.state.presence['bob']).toEqual([{ name: 'planner', kind: 'claude', online: true }])
  })
})

describe('link: keys and fingerprints', () => {
  it('blocks a member whose key changed until the user trusts it, then delivers what was held', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    // Alice must have pinned the first key, or the new one is simply her first sight of bob.
    await wait(() => expect(alice.state.pins['bob']).toBeDefined())
    bob.link.stop()
    const coder = alice.agent('coder')
    const bob2 = net.guest('bob', 'bob')
    bob2.agent('planner')
    await wait(() => expect(alice.link.members().find(m => m.handle === 'bob')?.changed).toBe(true))
    expect(alice.link.members().find(m => m.handle === 'bob')).toMatchObject({ changed: true, verified: false })
    // Nothing flows either way yet: bob2's presence waits unread at alice, and alice tells bob2 nothing.
    await wait(() => expect(alice.state.held.length).toBeGreaterThan(0))
    const before = bob2.send('planner', 'coder@alice', 'too early')
    expect(before?.type === 'error' && before.message).toMatch(/"coder" is not shared by alice/)
    expect(alice.link.trust('bob')).toMatch(/Trusted bob's new key. It is not verified/)
    // The held presence opens, so alice sees planner@bob; alice publishes hers, so bob2 can address coder.
    await remoteOnline(alice, 'planner@bob')
    await remoteOnline(bob2, 'coder@alice')
    bob2.send('planner', 'coder@alice', 'new laptop')
    await wait(() => expect(coder.msgs.map(m => m.text)).toEqual(['new laptop']))
    expect(alice.state.held).toEqual([])
  })

  it('refuses sends to a member whose key changed', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    bob.agent('planner')
    alice.agent('coder')
    await remoteOnline(alice, 'planner@bob')
    bob.link.stop()
    const bob2 = net.guest('bob', 'bob')
    bob2.agent('planner')
    await wait(() => expect(alice.link.members().find(m => m.handle === 'bob')?.changed).toBe(true))
    const r = alice.send('coder', 'planner@bob', 'x')
    expect(r?.type === 'error' && r.message).toMatch(/key changed/)
  })

  it('marks a key verified only when the code matches, and labels later messages', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    bob.agent('planner')
    await wait(() => expect(alice.state.pins['bob']).toBeDefined())
    expect(alice.link.verify('bob', 'AAAA-BBBB')).toMatchObject({ ok: false, text: expect.stringMatching(/may be intercepting/) })
    const code = bob.link.ownFingerprint().toLowerCase().replace(/-/g, ' ')
    expect(alice.link.verify('bob', code)).toMatchObject({ ok: true })
    await remoteOnline(bob, 'coder@alice')
    bob.send('planner', 'coder@alice', 'checked')
    await wait(() => expect(coder.msgs[0]?.origin?.keyVerified).toBe(true))
  })

  it('raises a member\'s level only once its key is verified, and labels its messages with it', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    const coder = alice.agent('coder')
    bob.agent('planner')
    await wait(() => expect(alice.state.pins['bob']).toBeDefined())
    expect(alice.link.allow('bob', 'chat')).toMatchObject({ ok: false, text: expect.stringMatching(/not verified, so the host could pose as bob/) })
    expect(alice.link.allow('carol', 'chat')).toMatchObject({ ok: false, text: expect.stringMatching(/No member "carol"/) })
    alice.link.verify('bob', bob.link.ownFingerprint())
    expect(alice.link.allow('bob', 'work')).toMatchObject({ ok: true, text: expect.stringMatching(/read-only commands/) })
    expect(alice.link.members().find(m => m.handle === 'bob')?.allow).toBe('work')
    await remoteOnline(bob, 'coder@alice')
    bob.send('planner', 'coder@alice', 'look at the tests')
    await wait(() => expect(coder.msgs[0]?.origin).toMatchObject({ keyVerified: true, allow: 'work' }))
    expect(alice.link.allow('bob', 'ask')).toMatchObject({ ok: true })
    expect(alice.state.pins['bob']?.allow).toBeUndefined()
  })

  it('drops a member back to ask when its key changes, even after the new key is verified', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    await wait(() => expect(alice.state.pins['bob']).toBeDefined())
    alice.link.verify('bob', bob.link.ownFingerprint())
    alice.link.allow('bob', 'chat')
    bob.link.stop()
    const bob2 = net.guest('bob', 'bob')
    await wait(() => expect(alice.link.members().find(m => m.handle === 'bob')?.changed).toBe(true))
    expect(alice.link.members().find(m => m.handle === 'bob')?.allow).toBe('ask')
    expect(alice.link.allow('bob', 'chat')).toMatchObject({ ok: false, text: expect.stringMatching(/key changed/) })
    alice.link.verify('bob', bob2.link.ownFingerprint())
    expect(alice.state.pins['bob']?.allow).toBeUndefined()
  })

  it('catches a host that swaps in its own key: the real fingerprint does not verify', () => {
    const net = network()
    const alice = net.hostNode()
    const realBob = { x: generateX25519(), e: generateEd25519() }
    const eve = { x: generateX25519(), e: generateEd25519() }
    const swapped = signDirectory(net.host.e.priv, {
      netId: net.relay.netId,
      network: 'team',
      epoch: 99,
      url: net.relay.url,
      urlSeq: 1,
      members: [
        { handle: 'alice', x: b64u.encode(net.host.x.pub), e: b64u.encode(net.host.e.pub), sig: b64u.encode(sign(net.host.e.priv, memberBinding(net.relay.netId, net.host.x.pub))), online: true, host: true },
        { handle: 'bob', x: b64u.encode(eve.x.pub), e: b64u.encode(eve.e.pub), sig: b64u.encode(sign(eve.e.priv, memberBinding(net.relay.netId, eve.x.pub))), online: true, host: false },
      ],
    })
    alice.link.applyDirectory(swapped)
    expect(alice.link.members().find(m => m.handle === 'bob')?.verified).toBe(false)
    const realCode = fingerprint(realBob.x.pub, realBob.e.pub)
    expect(alice.link.verify('bob', realCode)).toMatchObject({ ok: false, text: expect.stringMatching(/possibly the host, may be intercepting/) })
  })

  it('ignores a directory not signed by the pinned host', () => {
    const net = network()
    const alice = net.hostNode()
    const forged = signDirectory(generateEd25519().priv, { netId: net.relay.netId, network: 'team', epoch: 5, url: 'https://evil.example', urlSeq: 9, members: [] })
    alice.link.applyDirectory(forged)
    expect(alice.logs.join('\n')).toMatch(/ignored a directory not signed/)
    expect(alice.state.url).toBe('https://one.example')
  })

  it('compares codes ignoring case, spaces and dashes', () => {
    expect(normalizeCode('abcd-ef23 4567')).toBe('ABCDEF234567')
  })
})

describe('link: membership and address', () => {
  it('stops and drops off the network when the host removes the member', async () => {
    const net = network()
    net.hostNode()
    const bob = net.guest('bob')
    await wait(() => expect(bob.link.isConnected).toBe(true))
    net.relay.kick('bob')
    await wait(() => expect(bob.link.status).toBe('revoked'))
    const r = new Listener()
    const replies: Reply[] = []
    r.send = x => void replies.push(x)
    bob.hub.handle({ op: 'status' }, r)
    expect(replies[0]?.type === 'status' && replies[0].network).toBeUndefined()
  })

  it('follows the host to a new address from the signed directory', async () => {
    const net = network()
    net.hostNode()
    const bob = net.guest('bob')
    await wait(() => expect(bob.link.isConnected).toBe(true))
    net.relay.setUrl('https://two.example')
    await wait(() => expect(bob.transport?.urls).toEqual(['https://two.example']))
    expect(bob.state).toMatchObject({ url: 'https://two.example', urlSeq: 2 })
  })

  it('drops the outbox for a member who left', async () => {
    const net = network()
    const alice = net.hostNode()
    const bob = net.guest('bob')
    bob.agent('planner')
    alice.agent('coder')
    await remoteOnline(alice, 'planner@bob')
    bob.link.stop()
    net.relay.kick('bob')
    await wait(() => expect(alice.link.members().map(m => m.handle)).toEqual(['alice']))
    const r = alice.send('coder', 'planner@bob', 'x')
    expect(r?.type === 'error' && r.message).toMatch(/No member "bob"/)
  })
})

describe('allowLevel', () => {
  const pin = { x: 'x', e: 'e', verified: true, allow: { level: 'chat' as const, until: 2000 } }
  it('is the level while the key is verified and it has not lapsed', () => expect(allowLevel(pin, 1999)).toBe('chat'))
  it('lapses to ask at its end time', () => expect(allowLevel(pin, 2000)).toBe('ask'))
  it('is ask for an unverified key', () => expect(allowLevel({ ...pin, verified: false }, 0)).toBe('ask'))
  it('is ask while the key is changed', () => expect(allowLevel({ ...pin, changed: { x: 'y', e: 'f' } }, 0)).toBe('ask'))
  it('is ask with no pin or no level', () => {
    expect(allowLevel(undefined, 0)).toBe('ask')
    expect(allowLevel({ x: 'x', e: 'e', verified: true }, 0)).toBe('ask')
  })
  it('covers only the listed agents when the level names some', () => {
    const scoped = { ...pin, allow: { level: 'work' as const, agents: ['planner'] } }
    expect(allowLevel(scoped, 0, 'planner')).toBe('work')
    expect(allowLevel(scoped, 0, 'coder')).toBe('ask')
    expect(allowLevel(pin, 0, 'coder')).toBe('chat')
  })
})

describe('outsideReplayWindow', () => {
  const now = Date.parse('2026-11-21T12:00:00Z')
  it('accepts a message within the window', () => expect(outsideReplayWindow(new Date(now - MAX_MESSAGE_AGE_MS + 1000).toISOString(), now)).toBe(false))
  it('refuses one older than the window, so a replay past the seen record fails', () => {
    expect(outsideReplayWindow(new Date(now - MAX_MESSAGE_AGE_MS - 1000).toISOString(), now)).toBe(true)
  })
  it('refuses one stamped far in the future, and an unreadable stamp', () => {
    expect(outsideReplayWindow(new Date(now + 2 * 3600_000).toISOString(), now)).toBe(true)
    expect(outsideReplayWindow('not a date', now)).toBe(true)
  })
})

describe('holdCapped', () => {
  const entry = (from: string, seq: number): MailEntry => ({ seq, from, t: 'msg', env: { v: 1, id: 'a'.repeat(22), e: 'b'.repeat(43), c: 'c' }, at: '2026-11-21T12:00:00.000Z' })
  it('keeps everything under the cap', () => {
    const r = holdCapped([entry('bob', 1)], entry('bob', 2), 3)
    expect(r).toEqual({ held: [entry('bob', 1), entry('bob', 2)], dropped: 0 })
  })
  it('drops the sender\'s oldest at the cap, and never another member\'s mail', () => {
    const r = holdCapped([entry('bob', 1), entry('carol', 1), entry('bob', 2)], entry('bob', 3), 2)
    expect(r.dropped).toBe(1)
    expect(r.held.map(e => `${e.from}${e.seq}`)).toEqual(['carol1', 'bob2', 'bob3'])
  })
})
