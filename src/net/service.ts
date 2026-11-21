import { randomBytes } from 'node:crypto'
import type { Hub } from '../daemon/hub.js'
import { toError } from '../lib/errors.js'
import { NET_HTTP_SOCK } from '../paths.js'
import type { NetCommand, NetInfo } from '../schema.js'
import { assertSupported, b64u, fingerprint } from './crypto.js'
import { verifyDirectory } from './directory.js'
import { formatStatus, keyChoiceRefused, raiseRefused, TRIAL_NOTE, VERIFY_HINT } from './format.js'
import type { StaticKeys } from './handshake.js'
import { startNetServer, type NetServer } from './http-server.js'
import { decodeInvite, encodeInvite, urlProblem } from './invite.js'
import { Link, type Transport } from './link.js'
import { newHostState, Relay } from './relay.js'
import type { Directory, HostState, LinkState, ServerConfig } from './schema.js'
import { clearNetwork, linkFileStore, loadIdentity, readHost, readLink, readServer, relayFileStore, writeServer } from './store.js'
import { HttpTransport, joinOverHttp } from './transport-http.js'
import { ensureKeeper, keeperRunning, stopKeeper, waitReachable } from './keeper.js'
import { LocalTransport } from './transport-local.js'
import { decodeUrlUpdate } from './url-update.js'
import { PollWaits } from './waits.js'

/**
 * The daemon's network side. Starts the relay and HTTP server when this daemon hosts, and the link when it is
 * a member (the host is both). Answers `op: 'net'` requests. All rules live in the relay and link; this file
 * wires them to files, sockets and the clock.
 */

export interface NetReply {
  text: string
  info?: NetInfo
}

const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

type Mode = ServerConfig['mode']

/** The daemon always listens on its socket file. How the tunnel gets there depends on the mode. */
interface Hosting {
  relay: Relay
  waits: PollWaits
  server: NetServer | undefined
  mode: Mode
  /** `port` and `cloudflared`: the port the keeper holds and relays to the socket. */
  port: number
}

/** How often the keeper is checked for having died. A new trial tunnel means a new address. */
const KEEPER_CHECK_MS = 60_000
/** How long `net host --tunnel` waits for a new quick tunnel to answer before reporting. */
const TUNNEL_REACH_MS = 20_000

export class NetService {
  private keys: StaticKeys | undefined
  private hosting: Hosting | undefined
  private link: Link | undefined
  private readonly wakeups = new Set<() => void>()
  private keeperCheck: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly hub: Hub,
    private readonly log: (msg: string) => void,
  ) {}

  /** Picks up a saved network. Never throws: a bad network must not keep the local bridge down. */
  async start(): Promise<void> {
    try {
      const host = readHost()
      const saved = readLink()
      if (!host && !saved) return
      assertSupported()
      const server = readServer()
      if (host) await this.startHosting(host, server?.mode ?? 'port', server?.port ?? 0)
      if (saved) this.startLink(saved)
      else if (this.hosting) this.startOwnLink(this.hosting.relay)
    } catch (err) {
      this.log(`network did not start: ${toError(err).message}`)
    }
  }

  /** The hub's shared agents changed. */
  changed(): void {
    this.link?.changed()
  }

  async stop(): Promise<void> {
    if (this.keeperCheck) clearInterval(this.keeperCheck)
    // The keeper keeps the port (and a trial tunnel its address): the next daemon adopts it.
    this.link?.stop()
    this.wakeAll()
    await this.hosting?.server?.close()
  }

  /** `sessions`: the agent sessions of the calling shell. Empty for the user's own terminal. */
  async handle(cmd: NetCommand, sessions: string[] = []): Promise<NetReply> {
    switch (cmd.cmd) {
      case 'host':
        return this.host(cmd)
      case 'invite':
        return this.invite(cmd.ttlMs, cmd.handle)
      case 'connect':
        return this.connect(cmd.invite, cmd.handle)
      case 'status': {
        const info = this.info()
        return { text: formatStatus(info), info }
      }
      case 'fingerprint':
        return { text: `Your fingerprint: ${this.ownFingerprint()}\nRead it to each member over a call or a separate chat. A code sent through the bridge proves nothing.` }
      case 'verify': {
        if (sessions.length && this.keyChanged(cmd.handle)) throw new Error(keyChoiceRefused(cmd.handle, `verify ${cmd.handle} <code>`))
        const r = this.member().verify(cmd.handle, cmd.code)
        if (!r.ok) throw new Error(r.text)
        return { text: r.text }
      }
      case 'trust':
        if (sessions.length) throw new Error(keyChoiceRefused(cmd.handle, `trust ${cmd.handle}`))
        return { text: this.member().trust(cmd.handle) }
      case 'allow': {
        // The CLI refuses first and asks for a typed confirmation. This repeats the session check for a client
        // that reports its sessions; one that leaves them out is not stopped here. The terminal prompt is the gate.
        if (cmd.level !== 'ask' && sessions.length) throw new Error(raiseRefused(cmd.handle, cmd.level))
        const r = this.member().allow(cmd.handle, cmd.level, cmd.forMs, cmd.agents)
        if (!r.ok) throw new Error(r.text)
        return { text: r.text }
      }
      case 'kick':
        return this.kick(cmd.handle)
      case 'leave':
        return this.leave()
      case 'stop':
        return this.stopHosting()
      case 'set-url':
        return this.setUrl(cmd.value, cmd.unsigned)
    }
  }

  // --- Commands ---

  private async host(cmd: Extract<NetCommand, { cmd: 'host' }>): Promise<NetReply> {
    this.refuseIfInNetwork()
    const mode: Mode = cmd.tunnel === 'cloudflared' ? 'cloudflared' : cmd.socket ? 'socket' : 'port'
    const problem = cmd.url === undefined ? undefined : urlProblem(cmd.url)
    if (problem) throw new Error(problem)
    assertSupported()
    this.forgetOld()
    // A trial tunnel's address is known only once it runs.
    const state = newHostState(cmd.name, cmd.handle, cmd.url ?? `http://127.0.0.1:${cmd.port}`, randomBytes)
    relayFileStore(state).saveState(state)
    let hosting: Hosting
    let reachable = true
    try {
      hosting = await this.startHosting(state, mode, cmd.port, true)
      if (mode === 'cloudflared') reachable = await waitReachable(hosting.relay.url, TUNNEL_REACH_MS)
    } catch (err) {
      await this.hosting?.server?.close()
      this.hosting = undefined
      stopKeeper()
      clearNetwork()
      throw err
    }
    this.startOwnLink(hosting.relay)
    const info = this.info()
    const where: Record<Mode, string> = {
      port: `Listening on http://127.0.0.1:${hosting.port}, held by the port keeper. Point your tunnel there. Members reach it at ${hosting.relay.url}.`,
      socket: `Listening on the socket ${NET_HTTP_SOCK}. Point your tunnel there (a Cloudflare named tunnel: \`service: unix:${NET_HTTP_SOCK}\`). Members reach it at ${hosting.relay.url}.`,
      cloudflared: `Reachable at ${hosting.relay.url}, through local port ${hosting.port}, which the port keeper holds.`,
    }
    return {
      text: [
        `Hosting network "${cmd.name}" as ${cmd.handle}.`,
        where[mode],
        ...(mode === 'cloudflared' ? [TRIAL_NOTE] : []),
        ...(reachable ? [] : ['The tunnel does not answer yet. New quick tunnels can take a minute. If a member cannot connect, they can try again shortly.']),
        'Invite someone with `agent-bridge net invite`. Share sessions with /bridge share.',
        `Your fingerprint: ${info.fingerprint ?? ''}`,
      ].join('\n'),
      info,
    }
  }

  private invite(ttlMs: number, handle: string | undefined): NetReply {
    const relay = this.relayOrThrow('invite')
    const inv = relay.invite(ttlMs, relay.url, handle)
    return {
      text: [
        encodeInvite(inv),
        '',
        `Send this invite to one person, privately. It works once, until ${inv.exp}.`,
        'They give it to their agent, or run `agent-bridge net connect -` and paste it.',
        `After they join, compare fingerprints. Yours: ${this.ownFingerprint()}`,
        ...(this.hosting?.mode === 'cloudflared' ? [TRIAL_NOTE] : []),
      ].join('\n'),
    }
  }

  private async connect(text: string, handle: string | undefined): Promise<NetReply> {
    this.refuseIfInNetwork()
    const decoded = decodeInvite(text, new Date())
    if (!decoded.ok) throw new Error(decoded.error)
    const inv = decoded.invite
    assertSupported()
    const keys = this.identity()
    const reply = await joinOverHttp(inv, keys, handle ?? inv.handle)
    if (reply.directory.netId !== inv.netId || !verifyDirectory(b64u.decode(inv.he), reply.directory)) {
      throw new Error(`The member list from ${inv.url} is not signed by the host the invite names. Someone may be in the way. Ask the host.`)
    }
    this.forgetOld()
    const state = linkState(reply.directory, reply.handle, inv.url, inv.he, inv.hx)
    const link = this.startLink(state, reply.directory)
    const others = link.members().filter(m => !m.self).map(m => m.handle)
    return {
      text: [
        `Joined network "${inv.net}" as ${reply.handle}. Members: ${others.join(', ') || 'none'}.`,
        'Nothing here is shared yet. Run /bridge share in each session others may reach.',
        `Your fingerprint: ${this.ownFingerprint()}`,
        VERIFY_HINT,
      ].join('\n'),
      info: this.info(),
    }
  }

  private kick(handle: string): NetReply {
    const relay = this.relayOrThrow('kick')
    if (handle === relay.handle) throw new Error('You cannot remove yourself: you host this network. To end it for everyone, run `agent-bridge net stop`.')
    if (!relay.kick(handle)) throw new Error(`No member "${handle}". See \`agent-bridge net status\`.`)
    return { text: `Removed ${handle}. Its key cannot rejoin, and the other members drop it.` }
  }

  private async leave(): Promise<NetReply> {
    if (this.hosting) throw new Error('You host this network, so you cannot leave it. To end it for everyone, run `agent-bridge net stop`.')
    const link = this.link
    if (!link) {
      clearNetwork()
      return { text: 'Not in a network. Nothing to leave.' }
    }
    const name = link.info.network
    if (link.status === 'active') await link.leave()
    else link.stop()
    this.dropNetwork('you left the network')
    return { text: `Left network "${name}". Its members can no longer reach this daemon.` }
  }

  private async stopHosting(): Promise<NetReply> {
    this.relayOrThrow('stop')
    const name = this.link?.info.network ?? ''
    this.link?.stop()
    await this.hosting?.server?.close()
    stopKeeper()
    if (this.keeperCheck) clearInterval(this.keeperCheck)
    this.hosting = undefined
    this.dropNetwork('the network was stopped')
    return { text: `Stopped network "${name}" and deleted its members and mail. Members are cut off; they can run \`agent-bridge net leave\`.` }
  }

  private setUrl(value: string, unsigned: boolean): NetReply {
    if (this.hosting) {
      const problem = urlProblem(value)
      if (problem) throw new Error(problem)
      const r = this.hosting.relay.setUrl(value)
      if (!r.changed) return { text: `Already at ${value}.` }
      return { text: `Moved to ${value}. Connected members follow on their own. Send this line to any member who was offline:\nagent-bridge net set-url ${r.update}` }
    }
    const link = this.member()
    if (unsigned) {
      const problem = urlProblem(value)
      if (problem) throw new Error(problem)
      link.moveTo(value, link.info.urlSeq)
      this.wakeAll()
      return { text: `Now using ${value}. Warning: this address is not signed by the host. If it is not really your host, the session fails and nothing is read, but check with the host.` }
    }
    const d = decodeUrlUpdate(value, { hostEPub: b64u.decode(link.info.hostE), netId: link.info.netId, lastSeq: link.info.urlSeq })
    if (!d.ok) throw new Error(d.error)
    link.moveTo(d.update.url, d.update.seq)
    this.wakeAll()
    return { text: `Now using ${d.update.url}, signed by your host. Reconnecting.` }
  }

  // --- Wiring ---

  /**
   * Starts the relay and the server on the socket file, then (except in socket mode) the keeper that holds the port.
   * `fresh`: a new network, so failures throw. Otherwise a saved one: failures are logged, local members still work.
   */
  private async startHosting(state: HostState, mode: Mode, port: number, fresh = false): Promise<Hosting> {
    const keys = this.identity()
    const waits = new PollWaits(timer)
    const relay = new Relay({ store: relayFileStore(state), host: keys, now: () => new Date(), random: randomBytes, log: this.log, wake: h => waits.wake(h) })
    const hosting: Hosting = { relay, waits, server: undefined, mode, port }
    this.hosting = hosting
    try {
      hosting.server = await startNetServer({ relay, waits, log: this.log }, { socket: NET_HTTP_SOCK })
      this.log(`network "${state.network}" listening on ${NET_HTTP_SOCK}`)
    } catch (err) {
      if (fresh) throw err
      this.log(`network server did not start: ${toError(err).message}`)
      return hosting
    }
    if (mode === 'socket') {
      writeServer({ mode, port: 0 })
      return hosting
    }
    if (fresh) await this.keeper(true)
    else await this.keeper(false).catch(() => {})
    this.watchKeeper()
    return hosting
  }

  /** Checks now and then that the keeper still runs, and starts a new one if not. */
  private watchKeeper(): void {
    if (this.keeperCheck) clearInterval(this.keeperCheck)
    this.keeperCheck = setInterval(() => {
      if (!keeperRunning()) void this.keeper(false).catch(() => {})
    }, KEEPER_CHECK_MS)
    this.keeperCheck.unref()
  }

  /**
   * Adopts the running keeper, or starts one. A new trial tunnel has a new address: the network moves to it and
   * connected members follow. `fresh`: throw on failure (a new network); otherwise log it.
   */
  private async keeper(fresh: boolean): Promise<void> {
    const hosting = this.hosting
    if (!hosting || hosting.mode === 'socket') return
    const trial = hosting.mode === 'cloudflared'
    try {
      const k = await ensureKeeper(hosting.port, trial)
      hosting.port = k.port
      writeServer({ mode: hosting.mode, port: k.port })
      if (!trial || k.url === undefined || k.url === hosting.relay.url) return
      const { update } = hosting.relay.setUrl(k.url)
      if (!fresh) this.log(`the trial tunnel restarted at a new address, ${k.url}. Connected members follow. Send members who were offline: agent-bridge net set-url ${update}`)
    } catch (err) {
      if (fresh) throw err
      this.log(`the port keeper did not start: ${toError(err).message} Members cannot reach this network until it does.`)
    }
  }

  private startOwnLink(relay: Relay): void {
    const keys = this.identity()
    const d = relay.directory()
    this.startLink(linkState(d, relay.handle, relay.url, b64u.encode(keys.e.pub), b64u.encode(keys.x.pub)), d)
  }

  private startLink(state: LinkState, first?: Directory): Link {
    const keys = this.identity()
    const transport: Transport = this.hosting
      ? new LocalTransport(this.hosting.relay, this.hosting.waits)
      : new HttpTransport({ url: state.url, keys, hostX: b64u.decode(state.hostX), netId: state.netId, handle: state.handle, now: () => new Date() })
    const store = linkFileStore()
    const link = new Link(state, {
      hub: this.hub,
      transport,
      store,
      keys,
      now: () => new Date(),
      sleep: ms => this.sleep(ms),
      random: Math.random,
      log: this.log,
    })
    this.link = link
    if (first) link.applyDirectory(first)
    store.save(state)
    if (link.status === 'active') {
      link.run().catch((err: unknown) => this.log(`network link stopped: ${toError(err).message}`))
    }
    return link
  }

  private keyChanged(handle: string): boolean {
    return this.link?.members().some(m => m.handle === handle && m.changed) ?? false
  }

  /** Before a new network: anything an earlier one left (a removed member's files, its outbox) goes. */
  private forgetOld(): void {
    this.hub.dropRemote(undefined, 'a new network replaced the old one')
    clearNetwork()
  }

  /** Forgets the network on this daemon: outbox queues for its members, its files, the hub's view. */
  private dropNetwork(why: string): void {
    this.hub.dropRemote(undefined, why)
    this.link = undefined
    this.hub.setNetwork(undefined)
    clearNetwork()
    this.wakeAll()
  }

  private info(): NetInfo {
    const link = this.link
    if (!link) return { role: 'none', members: [] }
    const i = link.info
    const hosting = this.hosting
    const where = hosting === undefined ? {} : hosting.mode === 'socket' ? { socket: NET_HTTP_SOCK } : { port: hosting.port }
    return {
      role: hosting ? 'host' : 'member',
      network: i.network,
      handle: i.handle,
      url: hosting?.relay.url ?? i.url,
      ...where,
      connected: link.isConnected,
      state: i.state,
      fingerprint: this.ownFingerprint(),
      members: link.members(),
      ...(hosting ? { ...(hosting.relay.moved ? { urlUpdate: hosting.relay.urlUpdate() } : {}), trial: hosting.mode === 'cloudflared' } : {}),
    }
  }

  private refuseIfInNetwork(): void {
    const link = this.link
    if (this.hosting) throw new Error(`This daemon already hosts network "${link?.info.network ?? ''}". Stop it first with \`agent-bridge net stop\`.`)
    if (link?.status === 'active') throw new Error(`This daemon is already in network "${link.info.network}". Leave it first with \`agent-bridge net leave\`.`)
  }

  private relayOrThrow(what: string): Relay {
    if (!this.hosting) throw new Error(`Only the host can ${what}. This daemon does not host a network.`)
    return this.hosting.relay
  }

  private member(): Link {
    if (!this.link) throw new Error('Not in a network. Join one with `agent-bridge net connect <invite>`, or host one with `agent-bridge net host`.')
    return this.link
  }

  private identity(): StaticKeys {
    this.keys ??= loadIdentity()
    return this.keys
  }

  private ownFingerprint(): string {
    const k = this.identity()
    return fingerprint(k.x.pub, k.e.pub)
  }

  /** The link's waits. `wakeAll` ends them early: a new address or a stop should not wait out a backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(t)
        this.wakeups.delete(done)
        resolve()
      }
      const t = setTimeout(done, ms)
      this.wakeups.add(done)
    })
  }

  private wakeAll(): void {
    for (const w of [...this.wakeups]) w()
  }
}

function linkState(d: Directory, handle: string, url: string, hostE: string, hostX: string): LinkState {
  return {
    netId: d.netId,
    network: d.network,
    handle,
    url,
    urlSeq: d.urlSeq,
    hostE,
    hostX,
    cursor: 0,
    pins: {},
    seen: {},
    held: [],
    sent: {},
    presence: {},
    state: 'active',
  }
}
