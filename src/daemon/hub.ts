import { BRIDGE_SENDER, verifyHint } from '../format.js'
import { toError } from '../lib/errors.js'
import { autoBase, inFamily, nextFree, sessionTag } from '../names.js'
import { MAX_REMOTE_TEXT, RemoteAddress, splitAddress, type Message, type NetworkStatus, type Origin, type Peer, type PeerKind, type PeerStatus, type RemotePeer, type Reply, type Request, type SavedEndpoint } from '../schema.js'

/** A peer with nothing queued and no activity for this long is dropped, freeing its name. */
const PRUNE_AFTER_MS = 24 * 3600_000
/** A peer with messages queued is dropped after this long, messages included. Nobody is coming back for them. */
const PRUNE_QUEUED_AFTER_MS = 7 * 24 * 3600_000
/** lastSeen only feeds pruning, so it is written to disk at most this often per peer. */
/** The bridge's own notices use this sender, so no peer may send as it, claim it or listen on it. */
const RESERVED = `"${BRIDGE_SENDER}" is reserved for notices from the bridge itself. Pick another name.`
const PERSIST_SEEN_MS = 3600_000
/** Minimum gap between on-demand push-endpoint liveness sweeps. */
const PROBE_COOLDOWN_MS = 3_000
/** Short pause before retrying a failed liveness probe so a transient stall does not drop direct delivery. */
const PROBE_RETRY_DELAY_MS = 100
/** At most this many messages from the network wait per local peer. More are left with the sender's host. */
export const REMOTE_QUEUE_CAP = 50

/** A shared agent as members see it, in presence. */
export interface SharedPeer {
  name: string
  kind: PeerKind
  online: boolean
}

/** An outbox key, `<agent>@<member>`: a queue for another user's agent, not a local peer. */
export const isOutboxKey = (name: string): boolean => name.includes('@')

/** The network as the link last saw it. The hub only reads it: routing checks and status. */
export interface NetView {
  network: string
  /** This daemon's own member handle. */
  self: string
  connected: boolean
  members: NetMember[]
}

export interface NetMember {
  handle: string
  keyVerified: boolean
  /** The member's key changed and the user has not trusted the new one. */
  blocked: boolean
  peers: SharedPeer[]
}

/** A message from another member, already opened and checked by the link. */
export interface Inbound {
  fromAgent: string
  member: string
  to: string
  text: string
  origin: Origin
}

/**
 * Why an inbound message was refused. Codes, not text: they travel back to the sender's member as a bounce.
 * `busy`: the agent already has REMOTE_QUEUE_CAP unread network messages. Refusing (rather than waiting) keeps
 * one idle agent from holding up the member's whole mailbox, and tells the sender to try later.
 */
export type RefusedCode = 'not-shared' | 'invalid-sender' | 'busy'
export type InboundResult = 'stored' | { refused: RefusedCode }

/** One client connection, as the hub sees it. */
export interface Conn {
  send(reply: Reply): void
  end(): void
  readonly closed: boolean
  /** Delivery finishes later (a push endpoint), so a message handed to it is not yet "live". */
  readonly async?: boolean
  /** Tells the session something outside the message flow, e.g. that another session took its name. */
  notice?(name: string, text: string): void
}

export interface Store {
  load(): { peers: Peer[]; queues: Map<string, Message[]>; endpoints: SavedEndpoint[] }
  saveEndpoints(endpoints: SavedEndpoint[]): void
  savePeers(peers: Peer[]): void
  saveQueue(name: string, msgs: Message[]): void
  dropQueue(name: string): void
}

export interface HubDeps {
  store: Store
  now: () => Date
  newId: () => string
  pid: number
  log?: (msg: string) => void
  /** Pushes one message through an adapter's endpoint. Resolves once delivered. */
  deliver?: (kind: PeerKind, endpoint: Record<string, string>, msg: Message) => Promise<void>
  /**
   * The kind's check that an endpoint still reaches its session, or undefined.
   */
  probe?: (kind: PeerKind) => ((endpoint: Record<string, string>) => Promise<boolean>) | undefined
  /**
   * True when the kind's endpoints hold no credential and are safe to persist to disk.
   * Defaults to `false` when omitted so credential-bearing endpoints are never written by mistake.
   */
  persistEndpoint?: (kind: PeerKind) => boolean
  /** Told when the set of shared peers or their online state may have changed, so the link can publish it. */
  net?: { changed(): void }
}

/** Status as clients see it: session ids become tags, and the previous session is dropped. */
function redact(p: PeerStatus): PeerStatus {
  const { lastSession: _dropped, ...rest } = p
  return { ...rest, session: p.session === null ? null : sessionTag(p.session) }
}

/**
 * A listener backed by a push endpoint instead of a socket: each message goes out through deps.deliver.
 * Success acks it. Failure closes the conn, which puts the message back and drops the endpoint.
 */
class PushConn implements Conn {
  closed = false
  readonly async = true
  /** Last time this endpoint was registered, delivered to, or passed a liveness probe. */
  lastVerifiedAt: number
  constructor(
    private readonly hub: Hub,
    private readonly deliver: NonNullable<HubDeps['deliver']>,
    readonly kind: PeerKind,
    private readonly now: () => Date,
    readonly session: string,
    readonly endpoint: Record<string, string>,
    /** Saved to disk, so it is restored after a daemon restart. */
    readonly saved: boolean,
    private readonly onDrop: (conn: PushConn, why: string) => void,
  ) {
    this.lastVerifiedAt = now().getTime()
  }

  send(reply: Reply): void {
    if (reply.type !== 'msg') {
      if (reply.type !== 'ok') this.onDrop(this, reply.type === 'error' ? reply.message : reply.type)
      return
    }
    const msg = reply.msg
    this.deliver(this.kind, this.endpoint, msg).then(
      () => {
        this.lastVerifiedAt = this.now().getTime()
        this.hub.handle({ op: 'ack', as: msg.to, id: msg.id }, this)
      },
      (err: unknown) => this.onDrop(this, toError(err).message),
    )
  }

  end(): void {
    this.closed = true
  }

  /** Pushes one notice from the bridge itself, best effort. A push-mode session has no listener to print it. */
  notice(to: string, text: string): void {
    // From the bridge itself, so marked checked: agents should not treat it as a possibly forged peer message.
    const msg: Message = { id: 'notice', from: BRIDGE_SENDER, to, text, ts: this.now().toISOString(), verified: true }
    void this.deliver(this.kind, this.endpoint, msg).catch(() => {})
  }
}

interface Waiter {
  name: string
  conn: Conn
  stream: boolean
  session: string | null
  /** Set when another session took the name while this waiter held a message. Evicted on ack. */
  supersededBy?: string
}

type ListenRequest = Extract<Request, { op: 'listen' }>
type SendRequest = Extract<Request, { op: 'send' }>
type ClaimRequest = Extract<Request, { op: 'claim' }>
type HubRequest = Exclude<Request, { op: 'shutdown' | 'net' }>

/**
 * Message routing between named peers. Pure apart from the injected store, so it is tested without I/O.
 *
 * Rules:
 * - One message in flight per peer, removed only on ack. A dropped connection puts it back.
 * - A peer name binds to the newest session that listens with a session id. Older listeners are
 *   told they were superseded. Listeners without a session id only work while the name is unbound.
 * - `claim` gives a session its auto name: `base`, or the lowest free `base-<n>`. A name held by another
 *   session is never reused, online or not, until it is pruned. The same session always gets the same name.
 * - `drain` shows queued messages to whichever session a peer is bound to, and to nobody else.
 *   They leave the queue on `ack-drained`, so a hook that dies before printing loses nothing.
 */
export class Hub {
  private readonly peers = new Map<string, Peer>()
  private readonly queues = new Map<string, Message[]>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly inflight = new Map<string, { id: string; waiter: Waiter }>()
  private readonly byConn = new Map<Conn, Waiter>()
  /** Listeners that asked by session before the session held a name. Attached on claim. */
  private readonly pending = new Map<Conn, ListenRequest>()
  /** One push endpoint per session. */
  private readonly pushers = new Map<string, PushConn>()
  /** Sessions already asked to rejoin this daemon run, so the hint is not repeated every turn. */
  private readonly rejoinAsked = new Set<string>()
  /** Inside a claim: savePeers only marks dirty, and the claim writes once at the end. */
  private deferSave = false
  private dirty = false
  /** lastSeen as last written to disk, per peer. Throttles touch() against what is stored, not in memory. */
  private readonly savedSeen = new Map<string, number>()
  /** The network link: takes outbox messages one per remote key, acks with linkAck. */
  private link: Conn | undefined
  /** Outbox key to the id handed to the link and not yet acked. */
  private readonly remoteInflight = new Map<string, string>()
  private net: NetView | undefined
  private probing: Promise<number> | undefined

  constructor(private readonly deps: HubDeps) {
    const { peers, queues, endpoints } = deps.store.load()
    for (const p of peers) {
      this.peers.set(p.name, p)
      this.savedSeen.set(p.name, this.seenAt(p))
    }
    for (const [name, msgs] of queues) this.queues.set(name, msgs)
    // Restore saved endpoints, so a session that joined before a restart still receives without rejoining.
    if (endpoints.length) void this.restore(endpoints)
    // No prune here: listeners have not reconnected yet, so every peer looks idle.
  }

  handle(req: HubRequest, conn: Conn): void {
    switch (req.op) {
      case 'listen':
        return this.listen(req, conn)
      case 'claim': {
        const r = this.claim(req)
        if ('error' in r) return this.fail(conn, r.error)
        this.attachPending(req.session)
        return this.reply(conn, { type: 'claimed', name: r.name })
      }
      case 'send':
        return this.send(req, conn)
      case 'ack':
        return this.ack(req.as, req.id)
      case 'drain':
        this.touchSession(req.session)
        return this.reply(conn, { type: 'drained', msgs: this.drain(req.session), rejoin: this.needsRejoin(req.session) })
      case 'ack-drained':
        this.ackDrained(req.session, req.ids)
        return this.reply(conn, { type: 'ok' })
      case 'push':
        if (!this.deps.deliver) return this.fail(conn, 'this daemon cannot push. Run `agent-bridge restart`.')
      {
        const refused = this.push(req.kind, req.session, req.endpoint, this.deps.deliver, true)
        return refused ? this.fail(conn, refused) : this.reply(conn, { type: 'ok' })
      }
      case 'leave':
        if (req.as !== undefined) this.leave(req.as)
        else if (req.session !== undefined) this.leaveBySession(req.session)
        return this.reply(conn, { type: 'ok' })
      case 'share': {
        const refused = this.share(req.as, req.sessions, req.on)
        return refused ? this.fail(conn, refused) : this.reply(conn, { type: 'ok' })
      }
      case 'status':
        return this.reply(conn, {
          type: 'status',
          pid: this.deps.pid,
          peers: this.status().map(redact),
          remote: this.remotePeers(),
          ...(this.net ? { network: this.networkStatus(this.net) } : {}),
        })
    }
  }

  disconnect(conn: Conn): void {
    this.pending.delete(conn)
    if (conn === this.link) return this.detachLink(conn)
    const waiter = this.byConn.get(conn)
    if (!waiter) return
    this.removeWaiter(waiter)
    this.pump(waiter.name)
  }

  // --- Network. The link does the I/O and timers; these stay synchronous and deterministic. ---

  /** The link is ready to take outbox messages. */
  attachLink(conn: Conn): void {
    this.link = conn
    this.remoteInflight.clear()
    this.pumpRemoteAll()
  }

  /** The link went away. Messages it held stay at their queue heads. */
  detachLink(conn: Conn): void {
    if (this.link !== conn) return
    this.link = undefined
    this.remoteInflight.clear()
  }

  /** The host stored the message: drop it from the outbox and send the next one for that key. */
  linkAck(key: string, id: string): void {
    if (this.remoteInflight.get(key) !== id) return
    const q = this.queue(key)
    q.shift()
    this.remoteInflight.delete(key)
    // An outbox key exists per remote address ever used: drop it once empty rather than keep an empty file.
    if (!q.length) {
      this.queues.delete(key)
      return this.deps.store.dropQueue(key)
    }
    this.deps.store.saveQueue(key, q)
    this.pumpRemote(key)
  }

  /** The send failed. The message stays at the head; the link calls pumpRemoteAll after its backoff. */
  linkRetry(key: string, id: string): void {
    if (this.remoteInflight.get(key) === id) this.remoteInflight.delete(key)
  }

  pumpRemoteAll(): void {
    for (const key of this.queues.keys()) if (isOutboxKey(key)) this.pumpRemote(key)
  }

  setNetwork(view: NetView | undefined): void {
    this.net = view
  }

  /** A message from another member. Refused if the local peer is not shared, or `busy` when its network queue is full. */
  inbound(m: Inbound): InboundResult {
    // The sender ends up in a reply command an agent runs in a shell: only peer-name characters get through.
    const from = `${m.fromAgent}@${m.member}`
    if (!RemoteAddress.safeParse(from).success) return { refused: 'invalid-sender' }
    const peer = this.peers.get(m.to)
    // The same answer for unknown and unshared, so a guess learns nothing about which names exist here.
    if (!peer?.shared) return { refused: 'not-shared' }
    const q = this.queue(peer.name)
    if (q.filter(x => x.origin).length >= REMOTE_QUEUE_CAP) return { refused: 'busy' }
    q.push({ id: this.deps.newId(), from, to: peer.name, text: m.text, ts: this.deps.now().toISOString(), verified: false, origin: m.origin })
    this.deps.store.saveQueue(peer.name, q)
    this.pump(peer.name)
    return 'stored'
  }

  /** Queues a notice from the bridge itself for a local peer, e.g. a bounce from the network. */
  notify(name: string, text: string): void {
    if (!this.peers.has(name)) return
    const q = this.queue(name)
    q.push({ id: this.deps.newId(), from: BRIDGE_SENDER, to: name, text, ts: this.deps.now().toISOString(), verified: true })
    this.deps.store.saveQueue(name, q)
    this.pump(name)
  }

  /** What the link publishes to other members. Names and kinds only: never folders or sessions. */
  sharedPeers(): SharedPeer[] {
    return [...this.peers.values()].filter(p => p.shared).map(p => ({ name: p.name, kind: p.kind, online: this.liveWaiters(p).length > 0 }))
  }

  /**
   * Drops the outbox for a member that left or was removed, or with no member the whole outbox, when the network
   * ends: kept, it would go to whoever holds that handle on the next network. Every sender is told.
   */
  dropRemote(member: string | undefined, why: string): void {
    let dropped = 0
    for (const [key, q] of [...this.queues]) {
      if (!isOutboxKey(key) || (member !== undefined && !key.endsWith(`@${member}`))) continue
      dropped += q.length
      for (const m of q) this.notify(m.from, `Your message to ${key} (id ${m.id}) was not delivered: ${why}.`)
      this.queues.delete(key)
      this.remoteInflight.delete(key)
      this.deps.store.dropQueue(key)
    }
    if (dropped) this.deps.log?.(`dropped ${dropped} outbox message(s)${member === undefined ? '' : ` for ${member}`}: ${why}`)
  }

  status(): PeerStatus[] {
    return [...this.peers.values()].map(p => ({
      ...p,
      online: this.liveWaiters(p).length > 0,
      queued: this.queue(p.name).length,
    }))
  }

  private listen(req: ListenRequest, conn: Conn): void {
    if (req.as === BRIDGE_SENDER) return this.fail(conn, RESERVED)
    const as = req.as ?? this.nameOf(req.session, req.kind)
    if (!as) {
      this.pending.set(conn, req)
      return
    }
    const existing = this.peers.get(as)
    if (existing && existing.kind !== req.kind) {
      return this.fail(conn, `"${as}" is taken by a ${existing.kind} peer. Pick another name.`)
    }
    const session = req.session ?? null
    if (existing?.auto && existing.session && session !== existing.session) {
      return this.fail(
        conn,
        `"${as}" is an auto name held by another session. Run \`agent-bridge join\` for this session's own name, or \`agent-bridge leave ${as}\` first.`,
      )
    }
    const peer = existing ?? this.addPeer(as, req.kind)
    if (session && session !== peer.session) this.bind(peer, session)
    if (peer.session && session !== peer.session) {
      return this.fail(
        conn,
        `"${peer.name}" is bound to session ${sessionTag(peer.session)} and this listener has no session id. Run it from inside the agent, or run \`agent-bridge leave ${peer.name}\`.`,
      )
    }
    if (req.stream && session && this.waitersOf(peer.name).some(w => w.stream && w.session === session && !w.conn.closed)) {
      return this.fail(conn, `this session already receives "${peer.name}" through another stream listener. Nothing to do.`)
    }
    this.touch(peer)
    const waiter: Waiter = { name: peer.name, conn, stream: req.stream, session }
    this.waitersOf(peer.name).push(waiter)
    this.byConn.set(conn, waiter)
    if (peer.shared) this.netChanged()
    this.pump(peer.name)
  }

  /** Registers a push endpoint. Returns why it was refused, if it was. */
  private push(kind: PeerKind, session: string, endpoint: Record<string, string>, deliver: NonNullable<HubDeps['deliver']>, write: boolean): string | undefined {
    const old = this.pushers.get(session)
    if (old) this.dropPusher(old, false)
    const saved = Boolean(this.deps.persistEndpoint?.(kind))
    let refused: string | undefined
    const conn = new PushConn(this, deliver, kind, this.deps.now, session, endpoint, saved, (c, why) => {
      refused ??= why
      this.deps.log?.(`push endpoint for session ${sessionTag(session)} dropped: ${why}`)
      this.dropPusher(c)
    })
    this.pushers.set(session, conn)
    if (write && (saved || old?.saved)) this.saveEndpoints()
    this.listen({ op: 'listen', kind, session, stream: true }, conn)
    // listen answers synchronously when it refuses (another stream listener, a name clash).
    return conn.closed ? refused : undefined
  }

  /** True once for a bound session without a push endpoint: it should run `join` again to restore direct delivery. */
  private needsRejoin(session: string): boolean {
    if (this.pushers.has(session) || this.rejoinAsked.has(session) || !this.boundTo(session).length) return false
    this.rejoinAsked.add(session)
    return true
  }

  /**
   * Restores saved endpoints whose session is still there, so it receives without rejoining. Each is checked
   * before it is attached: a closed session's socket path can be reused by another session.
   */
  private async restore(endpoints: SavedEndpoint[]): Promise<void> {
    const deliver = this.deps.deliver
    const checks = await Promise.all(
      endpoints.map(async e => {
        const probe = this.deps.probe?.(e.kind)
        // A session that holds no name any more has nothing to receive for.
        const held = this.nameOf(e.session, e.kind) !== undefined
        return { e, ok: deliver !== undefined && probe !== undefined && held && (await probe(e.endpoint).catch(() => false)) }
      }),
    )
    for (const { e, ok } of checks) {
      // A session that rejoined during the check registered a fresh endpoint: keep that one.
      if (!ok || !deliver || this.pushers.has(e.session)) continue
      this.push(e.kind, e.session, e.endpoint, deliver, false)
    }
    const gone = checks.filter(c => !c.ok)
    for (const { e } of gone) this.deps.log?.(`saved endpoint for session ${sessionTag(e.session)} is gone: dropped.`)
    if (gone.length) this.saveEndpoints()
  }

  /** Writes the saved endpoints: every live one whose kind holds no credential. */
  private saveEndpoints(): void {
    const endpoints = [...this.pushers.values()].filter(c => c.saved).map(c => ({ session: c.session, kind: c.kind, endpoint: c.endpoint }))
    this.deps.store.saveEndpoints(endpoints)
  }

  private dropPusher(conn: PushConn, write = true): void {
    if (conn.closed) return
    conn.closed = true
    if (this.pushers.get(conn.session) === conn) {
      this.pushers.delete(conn.session)
      // A failed endpoint is gone (the session exited): do not restore it on the next start.
      if (write && conn.saved) this.saveEndpoints()
      // A lost endpoint earns a fresh rejoin hint, even if one was used earlier this run.
      this.rejoinAsked.delete(conn.session)
    }
    this.disconnect(conn)
  }

  private nameOf(session: string | undefined, kind: PeerKind): string | undefined {
    return session === undefined ? undefined : this.boundTo(session).find(p => p.kind === kind)?.name
  }

  private attachPending(session: string): void {
    for (const [conn, req] of [...this.pending]) {
      if (req.session !== session) continue
      this.pending.delete(conn)
      this.listen(req, conn)
    }
  }

  private claim(req: ClaimRequest): { name: string } | { error: string } {
    // One peers.json write per claim: the claim paths and the folder each mark it dirty.
    this.deferSave = true
    try {
      const r = req.name !== undefined ? this.claimNamed(req.name, req.kind, req.session, req.take === true) : this.claimAutoResult(req)
      const peer = 'name' in r ? this.peers.get(r.name) : undefined
      if (peer && req.folder && peer.folder !== req.folder) {
        peer.folder = req.folder
        this.dirty = true
      }
      return r
    } finally {
      this.deferSave = false
      if (this.dirty) this.savePeers()
    }
  }

  private claimAutoResult(req: ClaimRequest): { name: string } | { error: string } {
    const folder = req.folder ?? ''
    const name = this.claimAuto(folder, req.kind, req.session)
    if (name) return { name }
    return { error: `no free name left for ${autoBase(folder, req.kind)}. Every suffix up to -999 is taken. Pass a name instead.` }
  }

  /** An explicit name: bind it to the session, taking it over, unless it is another kind's or another session's auto name. */
  private claimNamed(name: string, kind: PeerKind, session: string, take: boolean): { name: string } | { error: string } {
    if (name === BRIDGE_SENDER) return { error: RESERVED }
    const current = this.nameOf(session, kind)
    // A session that already holds a name is renaming: in place when the new name is free.
    if (current && current !== name && !this.peers.has(name)) {
      this.rename(current, name)
      return { name }
    }
    const existing = this.peers.get(name)
    if (existing && existing.kind !== kind) return { error: `"${name}" is taken by a ${existing.kind} peer. Pick another name.` }
    if (existing?.auto && existing.session && existing.session !== session) {
      return { error: `"${name}" is an auto name held by another session. Pick another name.` }
    }
    // Taking a name from a session that is online and working is a hijack unless asked for explicitly.
    if (existing?.session && existing.session !== session && !take && this.liveWaiters(existing).length) {
      return { error: `"${name}" is online in another session. Pick another name, or join with --take to take it over.` }
    }
    const peer = existing ?? this.addPeer(name, kind)
    if (peer.session !== session) this.bind(peer, session)
    if (current && current !== name) this.moveSession(current, name, session)
    this.touch(peer)
    return { name }
  }

  /** Renames a peer, carrying its queue, in-flight message and listeners. The name is explicit from now on. */
  private rename(from: string, to: string): void {
    const peer = this.peers.get(from)
    if (!peer) return
    this.peers.delete(from)
    peer.name = to
    peer.auto = false
    this.peers.set(to, peer)
    const q = this.queue(from).map(m => ({ ...m, to }))
    this.queues.delete(from)
    this.queues.set(to, q)
    const ws = this.waitersOf(from)
    this.waiters.delete(from)
    for (const w of ws) w.name = to
    this.waiters.set(to, ws)
    const held = this.inflight.get(from)
    this.inflight.delete(from)
    if (held) this.inflight.set(to, held)
    this.savedSeen.delete(from)
    this.deps.store.dropQueue(from)
    this.deps.store.saveQueue(to, q)
    this.savePeers()
    if (peer.shared) this.netChanged()
  }

  /** Moves a session's listeners from one name to another and releases the old name. */
  private moveSession(from: string, to: string, session: string): void {
    for (const w of [...this.waitersOf(from)]) {
      if (w.session !== session) continue
      this.removeWaiter(w)
      w.name = to
      this.waitersOf(to).push(w)
      this.byConn.set(w.conn, w)
    }
    const old = this.peers.get(from)
    if (old?.session === session) {
      old.lastSession = session
      old.session = null
      this.savePeers()
      // The session's unread messages follow it to the new name.
      const carried = this.queue(from).splice(this.inflight.has(from) ? 1 : 0).map(m => ({ ...m, to }))
      if (carried.length) {
        const q = this.queue(to)
        q.push(...carried)
        this.deps.store.saveQueue(from, this.queue(from))
        this.deps.store.saveQueue(to, q)
      }
    }
    this.pump(from)
    this.pump(to)
  }

  /** The session's auto name, its name from before a leave, or a new one. Undefined when none is free. */
  private claimAuto(folder: string, kind: PeerKind, session: string): string | undefined {
    this.prune()
    const base = autoBase(folder, kind)
    const mine = (p: Peer): boolean => p.kind === kind && inFamily(p.name, base)
    const held = this.boundTo(session).find(mine)
    if (held) {
      this.touch(held)
      return held.name
    }
    const left = [...this.peers.values()].find(p => mine(p) && p.session === null && p.lastSession === session)
    if (left) {
      left.session = session
      this.touch(left)
      this.savePeers()
      return left.name
    }
    const name = nextFree(base, new Set(this.peers.keys()))
    if (!name) return undefined
    const peer = this.addPeer(name, kind, session)
    peer.auto = true
    this.savePeers()
    return name
  }

  private send(req: SendRequest, conn: Conn): void {
    if (req.from === BRIDGE_SENDER) return this.fail(conn, RESERVED)
    if (req.to !== undefined && isOutboxKey(req.to)) return this.sendRemote(req, req.to, conn)
    const to = req.toKind ? this.nearest(req.toKind, req.folder ?? '', req.from) : { name: req.to ?? '' }
    if ('error' in to) return this.fail(conn, to.error)
    const peer = this.peers.get(to.name)
    if (!peer) {
      const known = [...this.peers.keys()].join(', ') || 'none yet'
      return this.fail(conn, `unknown peer "${to.name}". Known peers: ${known}. A peer is known once it joins the bridge.`)
    }
    // A sender inside an agent session must use a name that session holds. Without a session, it is unverified.
    const verified = this.holds(req.from, req.sessions)
    if (req.sessions?.length && !verified) {
      return this.fail(conn, `"${req.from}" is not this session's name. Send as your own name; \`agent-bridge whoami\` prints it.`)
    }
    const msg: Message = { id: this.deps.newId(), from: req.from, to: peer.name, text: req.text, ts: this.deps.now().toISOString(), verified }
    const q = this.queue(peer.name)
    q.push(msg)
    this.deps.store.saveQueue(peer.name, q)
    this.pump(peer.name)
    // Live means this message went out now, not that a listener exists: one behind an in-flight message waits.
    const head = this.inflight.get(peer.name)
    const sentNow = head?.id === msg.id
    // A push endpoint's delivery is still running; only a socket listener counts as live.
    const pushed = sentNow && head.waiter.conn.async === true
    const live = sentNow && !pushed
    const listening = this.liveWaiters(peer).length ? [] : this.othersListening([peer.name, req.from])
    this.reply(conn, { type: 'sent', to: peer.name, id: msg.id, live, pushed, queued: q.length, listening, via: 'local' })
  }

  /** A send to `<agent>@<member>`: checked here, stored in the outbox, carried by the link. */
  private sendRemote(req: SendRequest, to: string, conn: Conn): void {
    const net = this.net
    if (!net) return this.fail(conn, 'No network. Run `agent-bridge net connect <invite>` or `agent-bridge net host` first.')
    const { agent, member: handle } = splitAddress(to)
    if (handle === net.self) return this.send({ ...req, to: agent }, conn)
    const holder = this.peers.get(req.from)
    if (!holder || !this.holds(req.from, req.sessions)) {
      return this.fail(conn, 'Sends to another user\'s agent need a checked sender. Run `agent-bridge send --as <your name>` from inside your agent session.')
    }
    if (!holder.shared) return this.fail(conn, `"${req.from}" is not shared on the network, so it cannot get replies. Run \`agent-bridge net share\` from its session first.`)
    const size = Buffer.byteLength(req.text)
    if (size > MAX_REMOTE_TEXT) return this.fail(conn, `The message is ${size} bytes. Messages to another user's agent are limited to ${MAX_REMOTE_TEXT}. Send less, or split it.`)
    const member = net.members.find(m => m.handle === handle)
    if (!member) {
      const known = net.members.map(m => m.handle).join(', ') || 'none yet'
      return this.fail(conn, `No member "${handle}" on network "${net.network}". Members: ${known}.`)
    }
    if (member.blocked) {
      return this.fail(conn, `${handle}'s key changed. ${verifyHint(handle)} Or accept it unverified: \`agent-bridge net trust ${handle}\`.`)
    }
    if (!member.peers.some(p => p.name === agent)) {
      const shared = member.peers.map(p => `${p.name}@${handle}`).join(', ')
      return this.fail(conn, `"${agent}" is not shared by ${handle}. ${shared ? `Shared by ${handle}: ${shared}.` : `${handle} shares nothing yet.`}`)
    }
    const msg: Message = { id: this.deps.newId(), from: req.from, to, text: req.text, ts: this.deps.now().toISOString(), verified: true }
    const q = this.queue(to)
    q.push(msg)
    this.deps.store.saveQueue(to, q)
    this.pumpRemote(to)
    const pushed = this.remoteInflight.get(to) === msg.id
    this.reply(conn, { type: 'sent', to, id: msg.id, live: false, pushed, queued: q.length, listening: [], via: 'network', keyVerified: member.keyVerified })
  }

  private pumpRemote(key: string): void {
    const head = this.queue(key)[0]
    const link = this.link
    if (!head || !link || link.closed || this.remoteInflight.has(key)) return
    this.remoteInflight.set(key, head.id)
    link.send({ type: 'msg', msg: head })
  }

  /** Only the session holding the name may share it. */
  private share(name: string, sessions: string[], on: boolean): string | undefined {
    const peer = this.peers.get(name)
    if (!peer || !this.holds(name, sessions)) return `"${name}" is not this session's name. Share your own name; \`agent-bridge whoami\` prints it.`
    if (Boolean(peer.shared) === on) return undefined
    if (on) peer.shared = true
    else delete peer.shared
    this.savePeers()
    this.netChanged()
    return undefined
  }

  private remotePeers(): RemotePeer[] {
    return (this.net?.members ?? []).flatMap(m =>
      m.peers.map(p => ({ address: `${p.name}@${m.handle}`, member: m.handle, kind: p.kind, online: p.online, keyVerified: m.keyVerified, blocked: m.blocked })),
    )
  }

  private networkStatus(net: NetView): NetworkStatus {
    let outbox = 0
    for (const [key, q] of this.queues) if (isOutboxKey(key)) outbox += q.length
    return { name: net.network, self: net.self, connected: net.connected, outbox }
  }

  private netChanged(): void {
    this.deps.net?.changed()
  }

  /** The one online peer of `kind`, other than the sender, that joined from `folder`. None or several: why. */
  private nearest(kind: PeerKind, folder: string, from: string): { name: string } | { error: string } {
    const online = [...this.peers.values()].filter(p => p.kind === kind && p.name !== from && this.liveWaiters(p).length > 0)
    const near = online.filter(p => p.folder === folder).map(p => p.name)
    const [only, ...more] = near
    if (only && !more.length) return { name: only }
    if (only) return { error: `${near.length} online ${kind} peers in this folder: ${near.join(', ')}. Send to one by name.` }
    const elsewhere = online.length ? ` Online elsewhere: ${online.map(p => p.name).join(', ')}.` : ''
    return { error: `no online ${kind} peer in this folder.${elsewhere} Send by name, or join one here.` }
  }

  private ack(as: string, id: string): void {
    // Ids are unique, so an ack under a name that was renamed or moved since still finds its message.
    const name = this.inflight.get(as)?.id === id ? as : [...this.inflight].find(([, h]) => h.id === id)?.[0]
    if (name === undefined) return
    const held = this.inflight.get(name)
    if (held?.id !== id) return
    const q = this.queue(name)
    q.shift()
    this.deps.store.saveQueue(name, q)
    this.inflight.delete(name)
    const acked = this.peers.get(name)
    if (acked) this.touch(acked)
    const w = held.waiter
    if (w.supersededBy) this.evict(w, { type: 'superseded', by: w.supersededBy })
    else if (!w.stream) {
      this.removeWaiter(w)
      w.conn.end()
    }
    this.pump(name)
  }

  private boundTo(session: string): Peer[] {
    return [...this.peers.values()].filter(p => p.session === session)
  }

  /** Queued messages for the session's peers. The in-flight head belongs to its listener. */
  private drain(session: string): Message[] {
    return this.boundTo(session).flatMap(p => this.queue(p.name).slice(this.inflight.has(p.name) ? 1 : 0))
  }

  private ackDrained(session: string, ids: string[]): void {
    this.touchSession(session)
    const done = new Set(ids)
    for (const p of this.boundTo(session)) {
      const q = this.queue(p.name)
      const headId = this.inflight.get(p.name)?.id
      const kept = q.filter(m => m.id === headId || !done.has(m.id))
      if (kept.length === q.length) continue
      this.queues.set(p.name, kept)
      this.deps.store.saveQueue(p.name, kept)
    }
  }

  hasPushers(): boolean {
    return this.pushers.size > 0
  }

  /**
   * Probes registered push endpoints in parallel and drops any whose session is gone.
   * Skips endpoints verified within PROBE_COOLDOWN_MS unless `force` is true, and deduplicates concurrent sweeps.
   */
  async probePushers(force = false): Promise<number> {
    if (!this.pushers.size || !this.deps.probe) return 0
    if (this.probing) return this.probing
    const now = this.deps.now().getTime()
    const due = [...this.pushers.entries()].filter(([, conn]) => force || now - conn.lastVerifiedAt >= PROBE_COOLDOWN_MS)
    if (!due.length) return 0
    const run = (async (): Promise<number> => {
      const checks = await Promise.all(
        due.map(async ([session, conn]) => {
          const probe = this.deps.probe?.(conn.kind)
          if (!probe) return { session, conn, ok: true }
          // Retry once after a short pause so a transient stall does not drop direct delivery.
          let ok = await probe(conn.endpoint).catch(() => false)
          if (!ok) {
            await new Promise(r => setTimeout(r, PROBE_RETRY_DELAY_MS))
            ok = await probe(conn.endpoint).catch(() => false)
          }
          return { session, conn, ok }
        }),
      )
      const doneAt = this.deps.now().getTime()
      let dropped = 0
      for (const { session, conn, ok } of checks) {
        if (this.pushers.get(session) !== conn) continue
        if (ok) {
          conn.lastVerifiedAt = doneAt
          continue
        }
        this.deps.log?.(`push endpoint for session ${sessionTag(session)} is gone: dropped.`)
        this.dropPusher(conn)
        dropped++
      }
      return dropped
    })().finally(() => {
      this.probing = undefined
    })
    this.probing = run
    return run
  }

  private leaveBySession(session: string): void {
    const pusher = this.pushers.get(session)
    if (pusher) this.dropPusher(pusher)
    for (const p of this.boundTo(session)) this.leave(p.name)
  }

  private leave(name: string): void {
    const peer = this.peers.get(name)
    if (!peer) return
    if (peer.session) peer.lastSession = peer.session
    peer.session = null
    const wasShared = this.unshare(peer)
    this.savePeers()
    for (const w of [...this.waitersOf(name)]) this.evict(w, { type: 'stopped' })
    if (wasShared) this.netChanged()
  }

  private bind(peer: Peer, session: string): void {
    peer.session = session
    // Exposure belongs to the session that chose it. A takeover or a new session starts unshared.
    const wasShared = this.unshare(peer)
    this.savePeers()
    if (wasShared) this.netChanged()
    for (const w of [...this.waitersOf(peer.name)]) {
      if (w.session === session) continue
      // Let a waiter finish the message it holds. ack evicts it.
      // Name the new holder by tag: a raw session id is what the sender check trusts.
      if (this.inflight.get(peer.name)?.waiter === w) w.supersededBy = sessionTag(session)
      else this.evict(w, { type: 'superseded', by: sessionTag(session) })
    }
  }

  private pump(name: string): void {
    if (isOutboxKey(name)) return this.pumpRemote(name)
    const peer = this.peers.get(name)
    const head = this.queue(name)[0]
    if (!peer || !head || this.inflight.has(name)) return
    const waiter = this.liveWaiters(peer).at(-1)
    if (!waiter) return
    this.inflight.set(name, { id: head.id, waiter })
    waiter.conn.send({ type: 'msg', msg: head })
  }

  /** Forgets a waiter. A message in flight to it goes back to the queue head; callers pump. */
  private removeWaiter(waiter: Waiter): void {
    this.waiters.set(waiter.name, this.waitersOf(waiter.name).filter(w => w !== waiter))
    this.byConn.delete(waiter.conn)
    if (this.inflight.get(waiter.name)?.waiter === waiter) this.inflight.delete(waiter.name)
    if (this.peers.get(waiter.name)?.shared) this.netChanged()
  }

  /** Tells a waiter why it is done and closes it. */
  private evict(waiter: Waiter, reply: Reply): void {
    if (reply.type === 'superseded') {
      waiter.conn.notice?.(
        waiter.name,
        `Another session took over "${waiter.name}". This session no longer receives on agent-bridge. To rejoin, ask the user, then join again under another name.`,
      )
    }
    waiter.conn.send(reply)
    waiter.conn.end()
    this.removeWaiter(waiter)
  }

  private liveWaiters(peer: Peer): Waiter[] {
    return this.waitersOf(peer.name).filter(w => !w.conn.closed && w.session === peer.session)
  }

  /** Records activity. Saved only when the stored value is stale; any other save carries it too. */
  private touch(peer: Peer): void {
    const now = this.deps.now()
    peer.lastSeen = now.toISOString()
    if (now.getTime() - (this.savedSeen.get(peer.name) ?? 0) > PERSIST_SEEN_MS) this.savePeers()
  }

  private seenAt(p: Peer): number {
    return Date.parse(p.lastSeen ?? p.joinedAt)
  }

  private othersListening(except: string[]): string[] {
    return [...this.peers.values()].filter(p => !except.includes(p.name) && this.liveWaiters(p).length).map(p => p.name)
  }

  private touchSession(session: string): void {
    for (const p of this.boundTo(session)) this.touch(p)
  }

  /**
   * Drops idle peers nobody listens on: after PRUNE_AFTER_MS with an empty queue, after
   * PRUNE_QUEUED_AFTER_MS with messages, which go too. Runs on claim, never at startup.
   */
  private prune(): void {
    const now = this.deps.now().getTime()
    let dropped = false
    for (const p of [...this.peers.values()]) {
      const queued = this.queue(p.name).length
      const idle = now - this.seenAt(p)
      if (this.waitersOf(p.name).length || idle <= (queued ? PRUNE_QUEUED_AFTER_MS : PRUNE_AFTER_MS)) continue
      this.peers.delete(p.name)
      this.queues.delete(p.name)
      this.waiters.delete(p.name)
      this.savedSeen.delete(p.name)
      this.deps.store.dropQueue(p.name)
      if (queued) this.deps.log?.(`pruned ${p.name}: idle ${Math.round(idle / 3600_000)}h, dropped ${queued} queued message(s).`)
      if (p.shared) this.netChanged()
      dropped = true
    }
    if (dropped) this.savePeers()
    // An outbox message nobody could deliver for a week goes too.
    for (const [key, q] of [...this.queues]) {
      const head = q[0]
      if (!isOutboxKey(key) || !head || now - Date.parse(head.ts) <= PRUNE_QUEUED_AFTER_MS) continue
      if (this.remoteInflight.has(key)) continue
      this.queues.delete(key)
      this.deps.store.dropQueue(key)
      this.deps.log?.(`pruned outbox ${key}: undelivered for a week, dropped ${q.length} message(s).`)
    }
  }

  private addPeer(name: string, kind: PeerKind, session: string | null = null): Peer {
    const now = this.deps.now().toISOString()
    const peer: Peer = { name, kind, session, joinedAt: now, lastSeen: now }
    this.peers.set(name, peer)
    this.savePeers()
    return peer
  }

  private savePeers(): void {
    if (this.deferSave) {
      this.dirty = true
      return
    }
    this.dirty = false
    for (const p of this.peers.values()) this.savedSeen.set(p.name, this.seenAt(p))
    this.deps.store.savePeers([...this.peers.values()])
  }

  /** True if one of `sessions` holds `name`. No sessions: an unchecked sender, so false. */
  private holds(name: string, sessions: string[] | undefined): boolean {
    const session = this.peers.get(name)?.session
    return session != null && (sessions?.includes(session) ?? false)
  }

  /** Clears `shared`. True if it was set, so the caller tells the network. */
  private unshare(peer: Peer): boolean {
    const was = peer.shared === true
    delete peer.shared
    return was
  }

  private queue(name: string): Message[] {
    let q = this.queues.get(name)
    if (!q) this.queues.set(name, (q = []))
    return q
  }

  private waitersOf(name: string): Waiter[] {
    let w = this.waiters.get(name)
    if (!w) this.waiters.set(name, (w = []))
    return w
  }

  private reply(conn: Conn, reply: Reply): void {
    conn.send(reply)
    conn.end()
  }

  private fail(conn: Conn, message: string): void {
    this.reply(conn, { type: 'error', message })
  }
}
