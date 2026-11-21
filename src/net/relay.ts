import { TokenBucket } from '../lib/rate.js'
import { nextFree } from '../names.js'
import type { Channel } from './channel.js'
import { b64u, fingerprint, sign } from './crypto.js'
import { signDirectory } from './directory.js'
import { acceptJoin, acceptOpen, channelFor, memberBinding, sealJoinReply, type StaticKeys } from './handshake.js'
import { hashToken, tokenMatches } from './invite.js'
import {
  Frame,
  JoinReq,
  NET_VERSION,
  OpenReq,
  RpcOp,
  type Directory,
  type FrameT,
  type HostState,
  type Invite,
  type Mailbox,
  type MailEntry,
  type MemberRec,
  type RpcReply,
} from './schema.js'
import { encodeUrlUpdate } from './url-update.js'

/**
 * The host's side of a network, as a state machine. It admits members, keeps a mailbox per member, and routes
 * sealed envelopes by handle. It never sees what is inside them. Pure apart from the injected store: the HTTP
 * server and the clock live outside, so every rule here is tested without sockets.
 */

/** Unacked entries handed out per poll. */
export const POLL_WINDOW = 32
export const MAILBOX_MAX_ENTRIES = 1000
const MAILBOX_MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS_PER_MEMBER = 4
/** A member counts as online for this long after its last request. Polls hold for 25s, so this spans a gap. */
export const ONLINE_MS = 60_000
const OPEN_SKEW_MS = 5 * 60_000
const DEDUPE_MS = 24 * 3600_000
const BAD_FRAMES_BEFORE_DROP = 10
const SEND_BURST = 50
const SEND_PER_SECOND = 10
const FULL_RETRY_MS = 5000
const RATE_LOG_MS = 60_000
export const RPC_PATH = '/v1/rpc'
export const RPC_REPLY_PATH = '/v1/rpc-reply'

export interface RelayStore {
  load(): { state: HostState; mailboxes: Map<string, Mailbox> }
  saveState(state: HostState): void
  saveMailbox(handle: string, mailbox: Mailbox): void
  dropMailbox(handle: string): void
}

export interface RelayDeps {
  store: RelayStore
  /** The host's static keys. The host is also a member under `state.handle`, with these keys. */
  host: StaticKeys
  now: () => Date
  random: (bytes: number) => Buffer
  log?: (msg: string) => void
  /** New mail or a new directory for `handle`, so a held poll can answer now. */
  wake?: (handle: string) => void
}

/** A fresh network's state. */
export function newHostState(network: string, handle: string, url: string, random: (bytes: number) => Buffer): HostState {
  return { netId: b64u.encode(random(16)), network, handle, url, urlSeq: 1, members: [], invites: [], tombstones: [], revoked: [], departed: [] }
}

interface Session {
  handle: string
  channel: Channel
  createdAt: number
  badFrames: number
}

export type PollOp = Extract<RpcOp, { op: 'poll' }>
/** What `rpc` gives the server: a sealed reply now, a poll to hold, or "open a session first". */
export type RpcResult = { type: 'reply'; frame: FrameT } | { type: 'wait'; handle: string; op: PollOp } | { type: 'unauthorized' } | { type: 'bad' }
export type OpenResult = { type: 'ok'; hsid: string; handle: string } | { type: 'revoked' } | { type: 'refused' }
/** A handled op: an answer, or a poll with nothing new yet. */
type OpResult = { reply: RpcReply } | { wait: PollOp }

/** A reply on the member's channel. */
const seal = (session: Session, reply: RpcReply): FrameT => session.channel.seal(RPC_REPLY_PATH, Buffer.from(JSON.stringify(reply)))

export class Relay {
  private readonly state: HostState
  private readonly mailboxes: Map<string, Mailbox>
  private readonly sessions = new Map<string, Session>()
  private readonly buckets = new Map<string, TokenBucket>()
  private readonly lastSeen = new Map<string, number>()
  private readonly rateLogged = new Map<string, number>()
  /** `<from>:<envelope id>` to when it was stored, so a retried send is not stored twice. */
  private readonly seen = new Map<string, number>()
  private online = new Set<string>()
  // Starts above zero, so a member holding epoch 0 from nowhere still gets a directory. Members compare for
  // inequality, so a restart that resets this never leaves them stale.
  private epoch = 1
  private dirCache: Directory | undefined
  private readonly hostSig: string

  constructor(private readonly deps: RelayDeps) {
    const loaded = deps.store.load()
    this.state = loaded.state
    this.mailboxes = loaded.mailboxes
    this.hostSig = b64u.encode(sign(deps.host.e.priv, memberBinding(this.state.netId, deps.host.x.pub)))
  }

  get netId(): string {
    return this.state.netId
  }

  get handle(): string {
    return this.state.handle
  }

  // --- Invites and joins ---

  /** A new single-use invite. Returns the invite to share; only its token's hash is kept. */
  invite(ttlMs: number, url: string, handle?: string): Invite {
    if (handle === this.state.handle) {
      throw new Error(`An invite cannot reserve "${handle}". It is the host's own handle. Pick another with --handle, or leave it out.`)
    }
    const now = this.deps.now()
    this.state.invites = this.state.invites.filter(i => !i.used && Date.parse(i.exp) > now.getTime())
    const token = b64u.encode(this.deps.random(32))
    const exp = new Date(now.getTime() + ttlMs).toISOString()
    this.state.invites.push({ hash: hashToken(token), exp, used: false, ...(handle !== undefined ? { handle } : {}) })
    this.save()
    return {
      v: NET_VERSION,
      net: this.state.network,
      netId: this.state.netId,
      url,
      hx: b64u.encode(this.deps.host.x.pub),
      he: b64u.encode(this.deps.host.e.pub),
      token,
      exp,
      ...(handle !== undefined ? { handle } : {}),
    }
  }

  /**
   * Admits a member. Any failure gives the same answer, so a prober learns nothing about which tokens exist.
   * Returns the sealed reply for the member.
   */
  join(raw: unknown): { ok: true; c: string; handle: string } | { ok: false; revoked?: true } {
    const req = JoinReq.safeParse(raw)
    if (!req.success) return this.refuse('join: malformed request')
    let accepted: ReturnType<typeof acceptJoin>
    try {
      accepted = acceptJoin(this.deps.host.x, this.state.netId, req.data)
    } catch {
      return this.refuse('join: could not open the request (wrong host key, or tampered)')
    }
    const now = this.deps.now().getTime()
    const invite = this.state.invites.find(i => !i.used && tokenMatches(accepted.body.token, i.hash))
    if (!invite) return this.refuse('join: unknown or used invite token')
    if (Date.parse(invite.exp) <= now) return this.refuse('join: expired invite')
    if (this.state.revoked.includes(req.data.mx) && invite.handle === undefined) {
      // The caller proved it holds this key and has a live token, so saying why reveals nothing to a prober.
      this.deps.log?.('join: a removed member\'s key tried to rejoin')
      return { ok: false, revoked: true }
    }
    const handle = this.admit(req.data, accepted.body.handle, invite.handle, accepted.body.sig)
    if (!handle) return this.refuse('join: no free handle')
    invite.used = true
    this.save()
    this.changed()
    this.deps.log?.(`member ${handle} joined (${fingerprint(b64u.decode(req.data.mx), b64u.decode(req.data.me))})`)
    return { ok: true, handle, c: sealJoinReply(accepted.replyKey, { handle, directory: this.directory() }) }
  }

  private refuse(why: string): { ok: false } {
    this.deps.log?.(why)
    return { ok: false }
  }

  /** Adds or updates the member record. Returns its handle. */
  private admit(req: JoinReq, wanted: string | undefined, reserved: string | undefined, sig: string): string | undefined {
    // The same key joining again keeps its handle.
    const same = this.state.members.find(m => m.x === req.mx)
    if (same) return same.handle
    const rec = (handle: string): MemberRec => ({ handle, x: req.mx, e: req.me, sig, joinedAt: this.deps.now().toISOString() })
    // A member who left and comes back with the same key gets its handle back: the others' pins still fit.
    const back = this.state.departed.find(d => d.x === req.mx)
    if (back && reserved === undefined) {
      this.state.departed = this.state.departed.filter(d => d !== back)
      this.state.tombstones = this.state.tombstones.filter(t => t !== back.handle)
      this.state.members.push(rec(back.handle))
      return back.handle
    }
    // Never the host's own handle, even from an invite saved before invite() refused it.
    if (reserved === this.state.handle) return undefined
    if (reserved !== undefined) {
      // The host chose this handle on purpose, e.g. the same person on a new machine. Replaces old keys.
      const old = this.state.members.find(m => m.handle === reserved)
      if (old) {
        this.dropMember(old, 'replaced by a new key')
        // The old machine is told it was removed, instead of being refused without a reason forever.
        this.state.revoked.push(old.x)
      }
      this.state.tombstones = this.state.tombstones.filter(t => t !== reserved)
      this.state.departed = this.state.departed.filter(d => d.handle !== reserved)
      this.state.revoked = this.state.revoked.filter(k => k !== req.mx)
      this.state.members.push(rec(reserved))
      return reserved
    }
    const taken = new Set([this.state.handle, ...this.state.members.map(m => m.handle), ...this.state.tombstones])
    const handle = nextFree(wanted ?? 'member', taken)
    if (handle) this.state.members.push(rec(handle))
    return handle
  }

  /**
   * True if `mx` is a member's or a removed member's key. Strangers never learn these: the directory only
   * travels inside sealed channels. The server uses this to give each member its own reconnect allowance.
   */
  knowsKey(mx: string): boolean {
    return this.state.members.some(m => m.x === mx) || this.state.revoked.includes(mx)
  }

  // --- Sessions ---

  open(raw: unknown): OpenResult {
    const req = OpenReq.safeParse(raw)
    if (!req.success) return { type: 'refused' }
    let ss: Buffer
    try {
      ss = acceptOpen(this.deps.host.x, this.state.netId, req.data, this.deps.now(), OPEN_SKEW_MS)
    } catch {
      return { type: 'refused' }
    }
    // The proof passed, so the caller holds this key: telling it that it was removed reveals nothing new.
    if (this.state.revoked.includes(req.data.mx)) return { type: 'revoked' }
    const member = this.state.members.find(m => m.x === req.data.mx)
    if (!member) return { type: 'refused' }
    const hsid = b64u.encode(this.deps.random(16))
    const channel = channelFor(ss, req.data.csid, hsid, member.handle, 'host')
    this.evictOldSessions(member.handle)
    this.sessions.set(channel.sid, { handle: member.handle, channel, createdAt: this.deps.now().getTime(), badFrames: 0 })
    this.seenNow(member.handle)
    return { type: 'ok', hsid, handle: member.handle }
  }

  private evictOldSessions(handle: string): void {
    const mine = [...this.sessions].filter(([, s]) => s.handle === handle).sort((a, b) => a[1].createdAt - b[1].createdAt)
    while (mine.length >= MAX_SESSIONS_PER_MEMBER) {
      const oldest = mine.shift()
      if (oldest) this.sessions.delete(oldest[0])
    }
  }

  /** One sealed request on a session. */
  rpc(sid: string, raw: unknown): RpcResult {
    const session = this.sessions.get(sid)
    if (!session) return { type: 'unauthorized' }
    const frame = Frame.safeParse(raw)
    let op: RpcOp
    try {
      if (!frame.success) throw new Error('malformed frame')
      op = RpcOp.parse(JSON.parse(session.channel.open(RPC_PATH, frame.data).toString('utf8')))
    } catch {
      // Tampered, replayed or garbage. Too many and the session goes: the member opens a new one.
      if (++session.badFrames >= BAD_FRAMES_BEFORE_DROP) this.sessions.delete(sid)
      this.deps.log?.(`rpc: rejected a frame from ${session.handle}`)
      return { type: 'bad' }
    }
    if (!this.memberExists(session.handle)) {
      this.sessions.delete(sid)
      return this.sealed(session, { ok: false, error: 'revoked' })
    }
    const r = this.handleOp(session.handle, op)
    return 'wait' in r ? { type: 'wait', handle: session.handle, op: r.wait } : this.sealed(session, r.reply)
  }

  /** Answers a held poll: new mail if there is some now, or an empty answer when the hold timed out. */
  answer(sid: string, op: PollOp): FrameT | undefined {
    const session = this.sessions.get(sid)
    if (!session) return undefined
    return seal(session, this.pollNow(session.handle, op) ?? { ok: true, mail: [] })
  }

  private sealed(session: Session, reply: RpcReply): RpcResult {
    return { type: 'reply', frame: seal(session, reply) }
  }

  /** The host's own member, in process: no channel, same rules. */
  localOp(op: RpcOp): OpResult {
    return this.handleOp(this.state.handle, op)
  }

  private handleOp(handle: string, op: RpcOp): OpResult {
    this.seenNow(handle)
    switch (op.op) {
      case 'send':
        return { reply: this.send(handle, op) }
      case 'ack':
        this.ack(handle, op.upTo)
        return { reply: { ok: true, mail: [] } }
      case 'poll': {
        const now = this.pollNow(handle, op)
        return now ? { reply: now } : op.waitMs > 0 ? { wait: op } : { reply: { ok: true, mail: [] } }
      }
      case 'leave': {
        const m = this.state.members.find(x => x.handle === handle)
        if (m) this.depart(m)
        return { reply: { ok: true, mail: [] } }
      }
    }
  }

  /** Mail after the cursor and a directory if the member's is out of date. Undefined: nothing new yet. */
  pollNow(handle: string, op: Pick<PollOp, 'cursor' | 'epoch'>): RpcReply | undefined {
    const mail = this.mailbox(handle).entries.filter(e => e.seq > op.cursor).slice(0, POLL_WINDOW)
    const stale = op.epoch !== this.epoch
    if (!mail.length && !stale) return undefined
    return { ok: true, mail, ...(stale ? { directory: this.directory() } : {}) }
  }

  private send(from: string, op: Extract<RpcOp, { op: 'send' }>): RpcReply {
    const now = this.deps.now().getTime()
    const bucket = this.bucket(from, now)
    if (!bucket.take(now)) {
      // Once per window per member: a burst should show in the log, not fill it.
      if (now - (this.rateLogged.get(from) ?? 0) > RATE_LOG_MS) {
        this.rateLogged.set(from, now)
        this.deps.log?.(`rate limited ${from}: over ${SEND_BURST} sends in a burst. It retries on its own.`)
      }
      return { ok: false, error: 'rate', retryAfterMs: bucket.waitMs(now) }
    }
    if (!this.memberExists(op.to)) return { ok: false, error: 'unknown-member' }
    this.pruneSeen(now)
    const key = `${from}:${op.env.id}`
    if (this.seen.has(key)) return { ok: true, mail: [] }
    const box = this.mailbox(op.to)
    // Only the latest presence from a sender matters.
    if (op.t === 'presence') box.entries = box.entries.filter(e => !(e.t === 'presence' && e.from === from))
    const bytes = box.entries.reduce((n, e) => n + e.env.c.length, 0) + op.env.c.length
    if (box.entries.length >= MAILBOX_MAX_ENTRIES || bytes > MAILBOX_MAX_BYTES) return { ok: false, error: 'mailbox-full', retryAfterMs: FULL_RETRY_MS }
    box.seq += 1
    const entry: MailEntry = { seq: box.seq, from, t: op.t, env: op.env, at: new Date(now).toISOString() }
    box.entries.push(entry)
    this.seen.set(key, now)
    this.deps.store.saveMailbox(op.to, box)
    this.deps.wake?.(op.to)
    return { ok: true, mail: [] }
  }

  private ack(handle: string, upTo: number): void {
    const box = this.mailbox(handle)
    const kept = box.entries.filter(e => e.seq > upTo)
    if (kept.length === box.entries.length) return
    box.entries = kept
    this.deps.store.saveMailbox(handle, box)
  }

  // --- Membership ---

  /** Removes a member: its mailbox and sessions go, its handle is never reassigned, its key cannot rejoin. */
  kick(handle: string): boolean {
    const m = this.state.members.find(x => x.handle === handle)
    if (!m) return false
    this.remove(m, 'removed by the host')
    return true
  }

  private remove(m: MemberRec, why: string): void {
    this.dropMember(m, why)
    this.state.tombstones.push(m.handle)
    this.state.revoked.push(m.x)
    this.save()
    this.changed()
  }

  /** A member left on its own. Its handle stays taken for it, and its key is not banned. */
  private depart(m: MemberRec): void {
    this.dropMember(m, 'left the network')
    this.state.tombstones.push(m.handle)
    this.state.departed = [...this.state.departed.filter(d => d.handle !== m.handle), { handle: m.handle, x: m.x }]
    this.save()
    this.changed()
  }

  private dropMember(m: MemberRec, why: string): void {
    this.state.members = this.state.members.filter(x => x !== m)
    this.mailboxes.delete(m.handle)
    this.deps.store.dropMailbox(m.handle)
    for (const [sid, s] of this.sessions) if (s.handle === m.handle) this.sessions.delete(sid)
    this.lastSeen.delete(m.handle)
    this.deps.log?.(`member ${m.handle} ${why}`)
  }

  members(): { handle: string; fingerprint: string; online: boolean; joinedAt: string; host: boolean }[] {
    const host = { handle: this.state.handle, fingerprint: fingerprint(this.deps.host.x.pub, this.deps.host.e.pub), online: true, joinedAt: '', host: true }
    return [
      host,
      ...this.state.members.map(m => ({
        handle: m.handle,
        fingerprint: fingerprint(b64u.decode(m.x), b64u.decode(m.e)),
        online: this.online.has(m.handle),
        joinedAt: m.joinedAt,
        host: false,
      })),
    ]
  }

  // --- Address ---

  /** Moves the network to a new address. Connected members follow from the directory; others need the update line. */
  setUrl(url: string): { changed: boolean; update: string } {
    const changed = url !== this.state.url
    if (changed) {
      this.state.url = url
      this.state.urlSeq += 1
      this.save()
      this.changed()
    }
    return { changed, update: this.urlUpdate() }
  }

  /** The signed line a cut-off guest pastes into `net set-url`. */
  urlUpdate(): string {
    return encodeUrlUpdate(this.deps.host.e.priv, { netId: this.state.netId, url: this.state.url, seq: this.state.urlSeq, ts: this.deps.now().toISOString() })
  }

  get url(): string {
    return this.state.url
  }

  /** True once the address has changed since the network began, so a member may hold an old one. */
  get moved(): boolean {
    return this.state.urlSeq > 1
  }

  /** Recomputes who is online. The server calls it on a timer; a change bumps the directory. */
  tick(): void {
    const now = this.deps.now().getTime()
    const online = new Set(this.state.members.filter(m => now - (this.lastSeen.get(m.handle) ?? 0) < ONLINE_MS).map(m => m.handle))
    const same = online.size === this.online.size && [...online].every(h => this.online.has(h))
    this.online = online
    if (!same) this.changed()
  }

  directory(): Directory {
    if (this.dirCache?.epoch === this.epoch) return this.dirCache
    const members = [
      { handle: this.state.handle, x: b64u.encode(this.deps.host.x.pub), e: b64u.encode(this.deps.host.e.pub), sig: this.hostSig, online: true, host: true },
      ...this.state.members.map(m => ({ handle: m.handle, x: m.x, e: m.e, sig: m.sig, online: this.online.has(m.handle), host: false })),
    ]
    const d = signDirectory(this.deps.host.e.priv, {
      netId: this.state.netId,
      network: this.state.network,
      epoch: this.epoch,
      url: this.state.url,
      urlSeq: this.state.urlSeq,
      members,
    })
    this.dirCache = d
    return d
  }

  // --- Helpers ---

  private memberExists(handle: string): boolean {
    return handle === this.state.handle || this.state.members.some(m => m.handle === handle)
  }

  private mailbox(handle: string): Mailbox {
    let box = this.mailboxes.get(handle)
    if (!box) this.mailboxes.set(handle, (box = { seq: 0, entries: [] }))
    return box
  }

  private bucket(handle: string, now: number): TokenBucket {
    let b = this.buckets.get(handle)
    if (!b) this.buckets.set(handle, (b = new TokenBucket(SEND_BURST, SEND_PER_SECOND, now)))
    return b
  }

  private seenNow(handle: string): void {
    this.lastSeen.set(handle, this.deps.now().getTime())
    if (handle !== this.state.handle && !this.online.has(handle)) {
      this.online.add(handle)
      this.changed()
    }
  }

  private pruneSeen(now: number): void {
    // Entries are only ever added, at `now`, so the Map is in time order: stop at the first one still fresh.
    for (const [k, at] of this.seen) {
      if (now - at <= DEDUPE_MS) return
      this.seen.delete(k)
    }
  }

  /** The directory changed: everyone's held poll should answer with the new one. */
  private changed(): void {
    this.epoch += 1
    this.dirCache = undefined
    this.deps.wake?.(this.state.handle)
    for (const m of this.state.members) this.deps.wake?.(m.handle)
  }

  private save(): void {
    this.deps.store.saveState(this.state)
  }
}

