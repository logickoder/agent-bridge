import type { Conn, Inbound, InboundResult, NetView, SharedPeer } from '../daemon/hub.js'
import { verifyHint } from '../format.js'
import { toError } from '../lib/errors.js'
import { levelCovers, splitAddress, type AllowLevel, type Message, type NetMemberInfo, type Reply } from '../schema.js'
import { b64u, concat, fingerprint, sha256 } from './crypto.js'
import { verifyDirectory } from './directory.js'
import { openEnvelope, sealEnvelope } from './envelope.js'
import { verifyMemberSig, type StaticKeys } from './handshake.js'
import { Inner, type BounceReason, type Directory, type LinkState, type MailEntry, type MailKind, type Pin, type RpcOp, type RpcReply } from './schema.js'

/**
 * One member's side of a network, between its hub and a transport to the host. It seals outbox messages to the
 * recipient member's pinned key, opens inbound ones against the sender's pinned key, keeps those pins (with
 * their fingerprint state), and publishes this member's shared agents. Pure: the transport, store, clock and
 * timers are injected, so the rules are tested without a network.
 */

/**
 * What a member's agents may do here now: its level while the key is verified, unchanged and not lapsed. With
 * `agent`, only if the level covers that local agent.
 */
export function allowLevel(pin: Pin | undefined, nowMs: number, agent?: string): AllowLevel {
  if (!pin?.verified || pin.changed || !pin.allow) return 'ask'
  if (pin.allow.until !== undefined && pin.allow.until <= nowMs) return 'ask'
  if (agent !== undefined && !levelCovers(pin.allow.agents, agent)) return 'ask'
  return pin.allow.level
}

const LEVEL_TEXT: Record<AllowLevel, string> = {
  ask: 'must check with you before acting on anything',
  chat: 'may answer from what they already know without asking you. Files, commands and anything about this machine still need you',
  work: 'may also read files and run read-only commands in their folder without asking you. Changes, network calls and anything outside the folder still need you',
}

/** The hub methods the link uses. `Hub` has them all. */
export interface HubPort {
  attachLink(conn: Conn): void
  detachLink(conn: Conn): void
  linkAck(key: string, id: string): void
  linkRetry(key: string, id: string): void
  pumpRemoteAll(): void
  setNetwork(view: NetView | undefined): void
  inbound(m: Inbound): InboundResult
  notify(name: string, text: string): void
  sharedPeers(): SharedPeer[]
  dropRemote(member: string | undefined, why: string): void
}

/** One RPC to the host. Throws when the host cannot be reached; a reachable host answers with a reply. */
export interface Transport {
  call(op: RpcOp): Promise<RpcReply>
  /** The host moved. The transport uses this address from now on. */
  setUrl(url: string): void
}

export interface LinkStore {
  save(state: LinkState): void
}

export interface LinkDeps {
  hub: HubPort
  transport: Transport
  store: LinkStore
  keys: StaticKeys
  now: () => Date
  /** Resolves after `ms`, or at once when the link stops. */
  sleep: (ms: number) => Promise<void>
  random: () => number
  log?: (msg: string) => void
  /** How long a poll may wait at the host. The host's own in-process link uses the same loop. */
  pollWaitMs?: number
}

const POLL_WAIT_MS = 25_000
const SEEN_MS = 8 * 24 * 3600_000
/**
 * Oldest message accepted, by the sender's own timestamp. Below SEEN_MS, so any message old enough to have left
 * the replay record is refused for its age: a host cannot hold mail back and deliver it again after 8 days.
 */
export const MAX_MESSAGE_AGE_MS = 7 * 24 * 3600_000
/** How far ahead of this clock a sender's timestamp may be. */
const MAX_CLOCK_AHEAD_MS = 3600_000
/** Unopened mail kept per member while its key is undecided. Older mail goes first. */
export const MAX_HELD_PER_MEMBER = 200

/** True if a message sent at `sentAt` is too old, too far in the future, or unreadable, as seen at `nowMs`. */
export function outsideReplayWindow(sentAt: string, nowMs: number): boolean {
  const at = Date.parse(sentAt)
  return !Number.isFinite(at) || nowMs - at > MAX_MESSAGE_AGE_MS || at - nowMs > MAX_CLOCK_AHEAD_MS
}

/** Adds `entry` to held mail, dropping its sender's oldest when that sender is at the cap. The count dropped. */
export function holdCapped(held: MailEntry[], entry: MailEntry, max = MAX_HELD_PER_MEMBER): { held: MailEntry[]; dropped: number } {
  const mine = held.filter(e => e.from === entry.from)
  const dropped = Math.max(0, mine.length + 1 - max)
  const gone = new Set(mine.slice(0, dropped))
  return { held: [...held.filter(e => !gone.has(e)), entry], dropped }
}
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 30_000
const PRESENCE_DEBOUNCE_MS = 1000

/** Notice wording for each bounce reason, chosen here so a member can never put its own words in a bridge notice. */
const BOUNCE_TEXT: Record<BounceReason, (agent: string) => string> = {
  'not-shared': agent => `"${agent}" is not shared on that network.`,
  'invalid-sender': () => 'the other side refused the sender name.',
  busy: agent => `"${agent}" has too many unread network messages. Send it again later.`,
  expired: () =>
    'it reached the other side more than 7 days after it was sent, or the two clocks differ by over an hour, so it was dropped as a possible replay. Send it again if it still matters.',
}

function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** Fingerprints are read aloud: compare letters and digits only, any case, any grouping. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z2-7]/g, '')

export class Link {
  private readonly conn: LinkConn
  private attached = false
  private connected = false
  private stopped = false
  /** Sends that failed in a row, for the retry backoff. Polls keep their own count. */
  private sendFailures = 0
  private retryDue = false
  private failures = 0
  /** The epoch of the directory held. Not persisted: the host compares for inequality. */
  private epoch = 0
  private presenceDue = false
  /** The shared-agent list last sent to every member, so an unchanged list is not sent again. */
  private lastPresence: string | undefined

  constructor(
    private readonly state: LinkState,
    private readonly deps: LinkDeps,
  ) {
    this.conn = new LinkConn(this)
    this.publishView()
  }

  get status(): LinkState['state'] {
    return this.state.state
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** What status shows and `net set-url` checks against. */
  get info(): Pick<LinkState, 'netId' | 'network' | 'handle' | 'url' | 'urlSeq' | 'hostE' | 'state'> {
    const { netId, network, handle, url, urlSeq, hostE, state } = this.state
    return { netId, network, handle, url, urlSeq, hostE, state }
  }

  /** The host moved. `seq` is the signed update's, or the current one for an address the user chose. */
  moveTo(url: string, seq: number): void {
    this.state.url = url
    this.state.urlSeq = Math.max(this.state.urlSeq, seq)
    this.failures = 0
    this.deps.transport.setUrl(url)
    this.save()
  }

  /** Leaves the network: tells the host if it can, then stops for good. */
  async leave(): Promise<void> {
    try {
      await this.deps.transport.call({ op: 'leave' })
    } catch (err) {
      // The host removes a member that never comes back only by kick. Say so, but leave locally anyway.
      this.deps.log?.(`could not tell the host this member left: ${toError(err).message}`)
    }
    this.state.state = 'left'
    this.save()
    this.stop()
    this.publishView()
  }

  /** Runs the poll loop until stop, removal, or leave. */
  async run(): Promise<void> {
    while (!this.stopped && this.state.state === 'active') {
      let reply: RpcReply
      try {
        reply = await this.deps.transport.call({ op: 'poll', cursor: this.state.cursor, epoch: this.epoch, waitMs: this.deps.pollWaitMs ?? POLL_WAIT_MS })
      } catch (err) {
        if (this.stopped) return
        await this.lost(err)
        continue
      }
      // A poll held across stop() still answers: a stopped link must not attach again or act on it.
      if (this.stopped) return
      if (!reply.ok) {
        if (reply.error === 'revoked') return this.removed()
        await this.lost(new Error(reply.error))
        continue
      }
      this.reached()
      if (reply.directory) this.applyDirectory(reply.directory)
      await this.processMail(reply.mail)
    }
  }

  stop(): void {
    this.stopped = true
    this.detach()
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** The hub's shared agents changed. Published to every member after a short pause, coalesced. */
  changed(): void {
    if (this.presenceDue || this.stopped) return
    this.presenceDue = true
    void this.deps.sleep(PRESENCE_DEBOUNCE_MS).then(async () => {
      this.presenceDue = false
      // Listener churn (a one-shot listener leaving and coming back) changes nothing members can see.
      if (JSON.stringify(this.deps.hub.sharedPeers()) === this.lastPresence) return
      await this.publishPresence()
    })
  }

  // --- Trust ---

  /** Accepts a member's changed key. It stays unverified: only `verify` marks a key checked. */
  trust(handle: string): string {
    const pin = this.state.pins[handle]
    if (!pin?.changed) return `${handle}'s key has not changed. Nothing to trust.`
    this.state.pins[handle] = { x: pin.changed.x, e: pin.changed.e, verified: false }
    this.unblocked(handle)
    return `Trusted ${handle}'s new key. It is not verified. ${verifyHint(handle)}`
  }

  /**
   * Sets what `handle`'s agents may do here without asking. Above `ask` it needs a verified, unchanged key: with
   * an unverified one the host could pose as that member and inherit the level.
   */
  allow(handle: string, level: AllowLevel, forMs?: number, agents?: string[]): { ok: true; text: string } | { ok: false; text: string } {
    const pin = this.state.pins[handle]
    if (!pin) return { ok: false, text: `No member "${handle}" seen on this network yet. Check the handle with \`agent-bridge net status\`.` }
    if (level === 'ask') {
      const { allow: _dropped, ...rest } = pin
      this.state.pins[handle] = rest
      this.save()
      return { ok: true, text: `${handle}'s agents ${LEVEL_TEXT.ask}.` }
    }
    if (pin.changed) return { ok: false, text: `${handle}'s key changed and is not decided yet. ${verifyHint(handle)} Then set the level.` }
    if (!pin.verified) {
      return { ok: false, text: `${handle}'s key is not verified, so the host could pose as ${handle}. ${verifyHint(handle)} Then set the level.` }
    }
    const until = forMs === undefined ? undefined : this.deps.now().getTime() + forMs
    this.state.pins[handle] = { ...pin, allow: { level, ...(until !== undefined ? { until } : {}), ...(agents?.length ? { agents } : {}) } }
    this.save()
    const lapse = until === undefined ? ' Until you change it with `agent-bridge net allow ' + handle + ' ask`.' : ` Until ${new Date(until).toISOString()}, then back to ask.`
    const scope = agents?.length ? ` This covers ${agents.join(', ')} only; your other shared agents still ask.` : ' This covers every agent you share.'
    return { ok: true, text: `${handle}'s agents ${LEVEL_TEXT[level]}.${scope}${lapse} Never secrets, settings or levels: those always need you.` }
  }

  /** Marks a member's key verified if `code` matches its pinned fingerprint. */
  verify(handle: string, code: string): { ok: true; text: string } | { ok: false; text: string } {
    const pin = this.state.pins[handle]
    if (!pin) return { ok: false, text: `No member "${handle}" seen on this network yet.` }
    const shown = pin.changed ?? pin
    const expected = fingerprint(b64u.decode(shown.x), b64u.decode(shown.e))
    if (normalizeCode(code) !== normalizeCode(expected)) {
      return {
        ok: false,
        text: `The code does not match the key this bridge has for ${handle}. Someone, possibly the host, may be intercepting your messages. Do not mark it verified. Check the code with ${handle} again over a call.`,
      }
    }
    // A new key is a new party: its level starts over at ask.
    this.state.pins[handle] = pin.changed ? { x: shown.x, e: shown.e, verified: true } : { ...pin, verified: true }
    if (pin.changed) this.unblocked(handle)
    else {
      this.save()
      this.publishView()
    }
    return { ok: true, text: `${handle}'s key is verified. The host cannot read your messages with ${handle} without you noticing a key change.` }
  }

  /** A key decision was made: open what was held, send what waited, and tell the member what this side shares. */
  private unblocked(handle: string): void {
    this.save()
    this.releaseHeld(handle)
    this.publishView()
    this.deps.hub.pumpRemoteAll()
    void this.publishPresence(handle)
  }

  /** This member's own fingerprint, to read to the others. */
  ownFingerprint(): string {
    return fingerprint(this.deps.keys.x.pub, this.deps.keys.e.pub)
  }

  /** Members with fingerprint and key state, for `net status`. */
  members(): NetMemberInfo[] {
    return (this.state.directory?.members ?? []).map(m => {
      const self = m.handle === this.state.handle
      const pin = this.state.pins[m.handle]
      const allow = self ? 'ask' : allowLevel(pin, this.deps.now().getTime())
      const until = allow !== 'ask' ? pin?.allow?.until : undefined
      const agents = allow !== 'ask' ? pin?.allow?.agents : undefined
      return {
        allow,
        ...(until !== undefined ? { allowUntil: new Date(until).toISOString() } : {}),
        ...(agents !== undefined ? { allowAgents: agents } : {}),
        handle: m.handle,
        fingerprint: fingerprint(b64u.decode(m.x), b64u.decode(m.e)),
        ...this.keyState(m.handle),
        ...(self ? { verified: true } : {}),
        online: m.online,
        host: m.host,
        self,
      }
    })
  }

  // --- Outbound: the hub hands outbox heads to LinkConn.send ---

  async deliver(msg: Message): Promise<void> {
    const key = msg.to
    const { agent, member: handle } = splitAddress(key)
    const pin = this.state.pins[handle]
    if (!pin || pin.changed) {
      // No key yet, or a changed one nobody decided on: hold it. trust or verify pumps again.
      return this.deps.hub.linkRetry(key, msg.id)
    }
    const inner: Inner = { t: 'msg', from: msg.from, to: agent, text: msg.text, sentAt: msg.ts }
    const envId = this.envelopeId(msg)
    // Recorded before sending: the bounce can come back before the host's reply does. A retry reuses the id.
    this.state.sent[b64u.encode(envId)] = { from: msg.from, agent, member: handle, at: this.deps.now().getTime() }
    let reply: RpcReply
    try {
      reply = await this.send(handle, pin, 'msg', inner, envId)
    } catch (err) {
      this.deps.hub.linkRetry(key, msg.id)
      return this.retryLater(err)
    }
    if (reply.ok) {
      this.sendFailures = 0
      this.save()
      return this.deps.hub.linkAck(key, msg.id)
    }
    if (reply.error === 'unknown-member') return this.deps.hub.dropRemote(handle, `${handle} is no longer on the network`)
    if (reply.error === 'revoked') return this.removed()
    this.deps.hub.linkRetry(key, msg.id)
    return this.retryLater(new Error(`the host refused it (${reply.error})`), reply.retryAfterMs)
  }

  /** Fixed per outbox message, so a retry is recognised by the host and the recipient as the same one. */
  private envelopeId(msg: Message): Buffer {
    return sha256(concat('ab/v1/envelope-id', this.state.netId, this.state.handle, msg.id, msg.ts)).subarray(0, 16)
  }

  private async send(to: string, pin: Pin, t: MailKind, inner: Inner, id: Uint8Array): Promise<RpcReply> {
    const env = sealEnvelope({
      netId: this.state.netId,
      from: this.state.handle,
      to,
      senderPriv: this.deps.keys.x.priv,
      senderPub: this.deps.keys.x.pub,
      recipientPub: b64u.decode(pin.x),
      id,
      plaintext: Buffer.from(JSON.stringify(inner)),
    })
    return this.deps.transport.call({ op: 'send', to, t, env })
  }

  /**
   * One retry for the whole outbox, however many keys failed: each key's failure would otherwise schedule its own
   * pump of every key. The wait grows with consecutive send failures, or is what the host asked for.
   */
  private async retryLater(err: unknown, waitMs?: number): Promise<void> {
    this.deps.log?.(`network send failed: ${toError(err).message}`)
    this.sendFailures += 1
    if (this.retryDue) return
    this.retryDue = true
    await this.deps.sleep(waitMs ?? backoffMs(this.sendFailures, this.deps.random))
    this.retryDue = false
    if (!this.stopped) this.deps.hub.pumpRemoteAll()
  }

  /** Sends this member's shared agents to every member (or only `only`), in parallel. */
  private async publishPresence(only?: string): Promise<void> {
    if (!this.connected) return
    const peers = this.deps.hub.sharedPeers()
    const sends = (this.state.directory?.members ?? []).flatMap(m => {
      if (m.handle === this.state.handle || (only !== undefined && m.handle !== only)) return []
      const pin = this.state.pins[m.handle]
      if (!pin || pin.changed) return []
      return [
        this.send(m.handle, pin, 'presence', { t: 'presence', peers }, Buffer.from(this.randomId())).then(
          () => true,
          (err: unknown) => {
            this.deps.log?.(`presence to ${m.handle} failed: ${toError(err).message}`)
            return false
          },
        ),
      ]
    })
    const allSent = (await Promise.all(sends)).every(Boolean)
    if (only === undefined && allSent) this.lastPresence = JSON.stringify(peers)
  }

  private randomId(): Uint8Array {
    const b = new Uint8Array(16)
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(this.deps.random() * 256)
    return sha256(concat('ab/v1/presence-id', this.state.handle, this.deps.now().toISOString(), b)).subarray(0, 16)
  }

  // --- Inbound ---

  /**
   * Processes mail in order and acks it. Every entry finishes here: delivered, held for a key decision, or
   * bounced. None waits on a local agent, so one idle agent never holds up the rest of the mailbox.
   */
  private async processMail(mail: MailEntry[]): Promise<void> {
    let done = this.state.cursor
    for (const entry of mail) {
      if (entry.seq <= done) continue
      this.receive(entry)
      done = entry.seq
    }
    if (done === this.state.cursor) return
    this.state.cursor = done
    this.pruneSeen()
    this.save()
    try {
      await this.deps.transport.call({ op: 'ack', upTo: done })
    } catch {
      // The cursor moved, so the next poll does not ask for these again; the next ack clears them at the host.
    }
  }

  /** One mailbox entry. */
  private receive(entry: MailEntry): void {
    const pin = this.state.pins[entry.from]
    if (!pin) {
      this.deps.log?.(`dropped mail from ${entry.from}: no key for that member`)
      return
    }
    if (pin.changed) {
      // Opened only once the user trusts or verifies the new key. Kept, up to a cap per member, so whoever holds
      // the new key cannot grow this file without bound while the user decides.
      const r = holdCapped(this.state.held, entry)
      this.state.held = r.held
      if (r.dropped) this.deps.log?.(`dropped ${r.dropped} held message(s) from ${entry.from}: over ${MAX_HELD_PER_MEMBER} wait for a key decision`)
      return
    }
    const seenKey = `${entry.from}:${entry.env.id}`
    if (this.state.seen[seenKey] !== undefined) return
    let inner: Inner
    try {
      const plain = openEnvelope({
        netId: this.state.netId,
        from: entry.from,
        to: this.state.handle,
        recipientPriv: this.deps.keys.x.priv,
        recipientPub: this.deps.keys.x.pub,
        senderPub: b64u.decode(pin.x),
        envelope: entry.env,
      })
      inner = Inner.parse(JSON.parse(plain.toString('utf8')))
      if (inner.t !== entry.t) throw new Error('kind mismatch')
    } catch {
      // Not sealed by the pinned sender for us, or not what it claims: a forgery or tampering. Never delivered.
      this.deps.log?.(`dropped mail from ${entry.from}: it did not open with the pinned key`)
      this.state.seen[seenKey] = this.deps.now().getTime()
      return
    }
    this.state.seen[seenKey] = this.deps.now().getTime()
    this.handleInner(entry.from, pin, inner, entry.env.id)
  }

  private handleInner(member: string, pin: Pin, inner: Inner, envId: string): void {
    switch (inner.t) {
      case 'presence':
        // Kept in the state, which processMail and releaseHeld save after the batch, so a restart still knows
        // who the others share until they say otherwise.
        this.state.presence[member] = inner.peers
        return this.publishView()
      case 'bounce': {
        // Believed only for a message this member really sent to that member. The wording is ours.
        const sent = this.state.sent[inner.ref]
        if (sent?.member !== member) {
          this.deps.log?.(`dropped a bounce from ${member} for a message not sent to it`)
          return
        }
        delete this.state.sent[inner.ref]
        return this.deps.hub.notify(sent.from, `Your message to ${sent.agent}@${member} was not delivered: ${BOUNCE_TEXT[inner.reason](sent.agent)}`)
      }
      case 'msg': {
        if (outsideReplayWindow(inner.sentAt, this.deps.now().getTime())) {
          this.deps.log?.(`dropped a message from ${member}: sent ${inner.sentAt}, outside the ${MAX_MESSAGE_AGE_MS / 86_400_000}-day window (a replay, or a clock far off)`)
          // The sender is told. A replayed copy bounces too, but the sender believes a bounce only for a message it
          // still remembers sending, so a replay past that record changes nothing.
          return void this.bounce(member, pin, envId, 'expired')
        }
        const r = this.deps.hub.inbound({
          fromAgent: inner.from,
          member,
          to: inner.to,
          text: inner.text,
          origin: { network: this.state.network, member, keyVerified: pin.verified, allow: allowLevel(pin, this.deps.now().getTime(), inner.to) },
        })
        if (r !== 'stored') void this.bounce(member, pin, envId, r.refused)
        return
      }
    }
  }

  private async bounce(member: string, pin: Pin, ref: string, reason: BounceReason): Promise<void> {
    try {
      await this.send(member, pin, 'bounce', { t: 'bounce', ref, reason }, Buffer.from(this.randomId()))
    } catch (err) {
      this.deps.log?.(`bounce to ${member} failed: ${toError(err).message}`)
    }
  }

  private releaseHeld(handle: string): void {
    const mine = this.state.held.filter(e => e.from === handle)
    this.state.held = this.state.held.filter(e => e.from !== handle)
    for (const entry of mine) this.receive(entry)
    this.save()
  }

  // --- Directory ---

  /** Applies a directory from the host. Anything not signed by the pinned host key is ignored. */
  applyDirectory(d: Directory): void {
    if (d.netId !== this.state.netId || !verifyDirectory(b64u.decode(this.state.hostE), d)) {
      this.deps.log?.('ignored a directory not signed by this network\'s host')
      return
    }
    this.epoch = d.epoch
    if (!d.members.some(m => m.handle === this.state.handle)) return this.removed()
    const before = new Set((this.state.directory?.members ?? []).map(m => m.handle))
    for (const m of d.members) {
      if (m.handle === this.state.handle) continue
      // A member record must carry the member's own signature binding its two keys.
      if (!verifyMemberSig(this.state.netId, b64u.decode(m.x), b64u.decode(m.e), m.sig)) {
        this.deps.log?.(`ignored ${m.handle} in the directory: its keys are not bound by its own signature`)
        continue
      }
      this.pinFromDirectory(m.handle, m.x, m.e)
    }
    for (const handle of before) {
      if (d.members.some(m => m.handle === handle)) continue
      delete this.state.presence[handle]
      this.deps.hub.dropRemote(handle, `${handle} left the network`)
    }
    if (d.urlSeq > this.state.urlSeq) {
      this.state.url = d.url
      this.state.urlSeq = d.urlSeq
      this.deps.transport.setUrl(d.url)
      this.deps.log?.(`the host moved to ${d.url}`)
    }
    this.state.directory = d
    this.save()
    this.publishView()
    // Outbox messages waiting for a key may have one now.
    this.deps.hub.pumpRemoteAll()
    // Someone new: tell them what this member shares.
    for (const m of d.members) if (!before.has(m.handle) && m.handle !== this.state.handle) void this.publishPresence(m.handle)
  }

  /** Pins a member's keys on first sight. Different keys later mark the pin changed; nothing flows until decided. */
  private pinFromDirectory(handle: string, x: string, e: string): void {
    const pin = this.state.pins[handle]
    if (!pin) {
      this.state.pins[handle] = { x, e, verified: false }
      return
    }
    if (pin.x === x && pin.e === e) {
      if (pin.changed) {
        const { changed: _gone, ...kept } = pin
        this.state.pins[handle] = kept
      }
      return
    }
    if (pin.changed?.x !== x || pin.changed.e !== e) {
      this.state.pins[handle] = { ...pin, changed: { x, e } }
      this.deps.log?.(`${handle}'s key changed. Messages to and from ${handle} wait until the user trusts or verifies it.`)
    }
  }

  // --- Connection state ---

  private reached(): void {
    this.failures = 0
    if (!this.connected) {
      this.connected = true
      this.publishView()
      void this.publishPresence()
    }
    if (!this.attached) {
      this.attached = true
      this.deps.hub.attachLink(this.conn)
    }
  }

  private async lost(err: unknown): Promise<void> {
    if (this.connected) this.deps.log?.(`lost the host: ${toError(err).message}`)
    this.connected = false
    this.detach()
    this.publishView()
    await this.deps.sleep(backoffMs(this.failures++, this.deps.random))
  }

  private detach(): void {
    if (!this.attached) return
    this.attached = false
    this.deps.hub.detachLink(this.conn)
  }

  private removed(): void {
    this.deps.log?.('this member was removed from the network')
    this.state.state = 'revoked'
    this.save()
    this.stop()
    this.deps.hub.dropRemote(undefined, 'this daemon was removed from the network')
    this.publishView()
  }

  /** A member's key as the user decided it: checked against a fingerprint, or changed and not yet decided. */
  private keyState(handle: string): { verified: boolean; changed: boolean } {
    const pin = this.state.pins[handle]
    return { verified: pin?.verified === true, changed: pin?.changed !== undefined }
  }

  /** What the hub shows and checks against. */
  private publishView(): void {
    if (this.state.state !== 'active') return this.deps.hub.setNetwork(undefined)
    const members = (this.state.directory?.members ?? [])
      .filter(m => m.handle !== this.state.handle)
      .map(m => {
        const { verified, changed } = this.keyState(m.handle)
        return { handle: m.handle, keyVerified: verified, blocked: changed, peers: this.state.presence[m.handle] ?? [] }
      })
    this.deps.hub.setNetwork({ network: this.state.network, self: this.state.handle, connected: this.connected, members })
  }

  private pruneSeen(): void {
    const now = this.deps.now().getTime()
    for (const [k, at] of Object.entries(this.state.seen)) if (now - at > SEEN_MS) delete this.state.seen[k]
    for (const [k, s] of Object.entries(this.state.sent)) if (now - s.at > SEEN_MS) delete this.state.sent[k]
  }

  private save(): void {
    this.deps.store.save(this.state)
  }
}

/** The link as the hub sees it: a listener that takes outbox heads. */
class LinkConn implements Conn {
  readonly async = true
  constructor(private readonly link: Link) {}

  get closed(): boolean {
    return this.link.isStopped
  }

  send(reply: Reply): void {
    if (reply.type === 'msg') void this.link.deliver(reply.msg)
  }

  end(): void {}
}

