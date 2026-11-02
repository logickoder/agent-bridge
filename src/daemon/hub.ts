import { autoBase, inFamily, nextFree } from '../names.js'
import type { Message, Peer, PeerKind, PeerStatus, Reply, Request } from '../schema.js'

/** A peer with nothing queued and no activity for this long is dropped, freeing its name. */
const PRUNE_AFTER_MS = 24 * 3600_000
/** A peer with messages queued is dropped after this long, messages included. Nobody is coming back for them. */
const PRUNE_QUEUED_AFTER_MS = 7 * 24 * 3600_000
/** lastSeen only feeds pruning, so it is written to disk at most this often per peer. */
const PERSIST_SEEN_MS = 3600_000

/** One client connection, as the hub sees it. */
export interface Conn {
  send(reply: Reply): void
  end(): void
  readonly closed: boolean
}

export interface Store {
  load(): { peers: Peer[]; queues: Map<string, Message[]> }
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
}

/**
 * A listener backed by a push endpoint instead of a socket: each message goes out through deps.deliver.
 * Success acks it. Failure closes the conn, which puts the message back and drops the endpoint.
 */
class PushConn implements Conn {
  closed = false
  constructor(
    private readonly hub: Hub,
    private readonly deliver: NonNullable<HubDeps['deliver']>,
    private readonly kind: PeerKind,
    readonly endpoint: Record<string, string>,
    private readonly onDrop: (conn: PushConn, why: string) => void,
  ) {}

  send(reply: Reply): void {
    if (reply.type !== 'msg') {
      if (reply.type !== 'ok') this.onDrop(this, reply.type === 'error' ? reply.message : reply.type)
      return
    }
    const msg = reply.msg
    this.deliver(this.kind, this.endpoint, msg).then(
      () => this.hub.handle({ op: 'ack', as: msg.to, id: msg.id }, this),
      (err: unknown) => this.onDrop(this, err instanceof Error ? err.message : String(err)),
    )
  }

  end(): void {
    this.closed = true
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
type HubRequest = Exclude<Request, { op: 'shutdown' }>

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
  /** One push endpoint per session, in memory only. */
  private readonly pushers = new Map<string, PushConn>()
  /** lastSeen as last written to disk, per peer. Throttles touch() against what is stored, not in memory. */
  private readonly savedSeen = new Map<string, number>()

  constructor(private readonly deps: HubDeps) {
    const { peers, queues } = deps.store.load()
    for (const p of peers) this.peers.set(p.name, p)
    for (const [name, msgs] of queues) this.queues.set(name, msgs)
    for (const p of peers) this.savedSeen.set(p.name, this.seenAt(p))
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
        return this.reply(conn, { type: 'drained', msgs: this.drain(req.session) })
      case 'ack-drained':
        this.ackDrained(req.session, req.ids)
        return this.reply(conn, { type: 'ok' })
      case 'push':
        if (!this.deps.deliver) return this.fail(conn, 'this daemon cannot push. Run `agent-bridge restart`.')
        this.push(req.kind, req.session, req.endpoint, this.deps.deliver)
        return this.reply(conn, { type: 'ok' })
      case 'leave':
        this.leave(req.as)
        return this.reply(conn, { type: 'ok' })
      case 'status':
        return this.reply(conn, { type: 'status', pid: this.deps.pid, peers: this.status() })
    }
  }

  disconnect(conn: Conn): void {
    this.pending.delete(conn)
    const waiter = this.byConn.get(conn)
    if (!waiter) return
    this.removeWaiter(waiter)
    this.pump(waiter.name)
  }

  status(): PeerStatus[] {
    return [...this.peers.values()].map(p => ({
      ...p,
      online: this.liveWaiters(p).length > 0,
      queued: this.queue(p.name).length,
    }))
  }

  private listen(req: ListenRequest, conn: Conn): void {
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
        `"${peer.name}" is bound to session ${peer.session} and this listener has no session id. Run it from inside the agent, or run \`agent-bridge leave ${peer.name}\`.`,
      )
    }
    if (req.stream && session && this.waitersOf(peer.name).some(w => w.stream && w.session === session && !w.conn.closed)) {
      return this.fail(conn, `this session already receives "${peer.name}" through another stream listener. Nothing to do.`)
    }
    this.touch(peer)
    const waiter: Waiter = { name: peer.name, conn, stream: req.stream, session }
    this.waitersOf(peer.name).push(waiter)
    this.byConn.set(conn, waiter)
    this.pump(peer.name)
  }

  private push(kind: PeerKind, session: string, endpoint: Record<string, string>, deliver: NonNullable<HubDeps['deliver']>): void {
    const old = this.pushers.get(session)
    if (old) this.dropPusher(old)
    const conn = new PushConn(this, deliver, kind, endpoint, (c, why) => {
      this.deps.log?.(`push endpoint for session ${session} dropped: ${why}`)
      this.dropPusher(c)
    })
    this.pushers.set(session, conn)
    this.listen({ op: 'listen', kind, session, stream: true }, conn)
  }

  private dropPusher(conn: PushConn): void {
    if (conn.closed) return
    conn.closed = true
    for (const [session, c] of this.pushers) if (c === conn) this.pushers.delete(session)
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
    if (req.name !== undefined) return this.claimNamed(req.name, req.kind, req.session)
    const folder = req.folder ?? ''
    const name = this.claimAuto(folder, req.kind, req.session)
    if (name) return { name }
    return { error: `no free name left for ${autoBase(folder, req.kind)}. Every suffix up to -999 is taken. Pass a name instead.` }
  }

  /** An explicit name: bind it to the session, taking it over, unless it is another kind's or another session's auto name. */
  private claimNamed(name: string, kind: PeerKind, session: string): { name: string } | { error: string } {
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
    const peer = this.peers.get(req.to)
    if (!peer) {
      const known = [...this.peers.keys()].join(', ') || 'none yet'
      return this.fail(conn, `unknown peer "${req.to}". Known peers: ${known}. A peer is known once it joins the bridge.`)
    }
    const msg: Message = { id: this.deps.newId(), from: req.from, to: peer.name, text: req.text, ts: this.deps.now().toISOString() }
    const q = this.queue(peer.name)
    q.push(msg)
    this.deps.store.saveQueue(peer.name, q)
    this.pump(peer.name)
    // Live means this message went out now, not that a listener exists: one behind an in-flight message waits.
    const live = this.inflight.get(peer.name)?.id === msg.id
    const listening = this.liveWaiters(peer).length ? [] : this.othersListening([peer.name, req.from])
    this.reply(conn, { type: 'sent', id: msg.id, live, queued: q.length, listening })
  }

  private ack(name: string, id: string): void {
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

  private leave(name: string): void {
    const peer = this.peers.get(name)
    if (!peer) return
    if (peer.session) peer.lastSession = peer.session
    peer.session = null
    this.savePeers()
    for (const w of [...this.waitersOf(name)]) this.evict(w, { type: 'stopped' })
  }

  private bind(peer: Peer, session: string): void {
    peer.session = session
    this.savePeers()
    for (const w of [...this.waitersOf(peer.name)]) {
      if (w.session === session) continue
      // Let a waiter finish the message it holds. ack evicts it.
      if (this.inflight.get(peer.name)?.waiter === w) w.supersededBy = session
      else this.evict(w, { type: 'superseded', by: session })
    }
  }

  private pump(name: string): void {
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
  }

  /** Tells a waiter why it is done and closes it. */
  private evict(waiter: Waiter, reply: Reply): void {
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
      dropped = true
    }
    if (dropped) this.savePeers()
  }

  private addPeer(name: string, kind: PeerKind, session: string | null = null): Peer {
    const now = this.deps.now().toISOString()
    const peer: Peer = { name, kind, session, joinedAt: now, lastSeen: now }
    this.peers.set(name, peer)
    this.savePeers()
    return peer
  }

  private savePeers(): void {
    for (const p of this.peers.values()) this.savedSeen.set(p.name, this.seenAt(p))
    this.deps.store.savePeers([...this.peers.values()])
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
