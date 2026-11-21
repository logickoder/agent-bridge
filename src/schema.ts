import { z } from 'zod'

export const PEER_KINDS = ['claude', 'agy', 'opencode'] as const

export const MAX_PEER_NAME = 32
/** Longest message text that crosses a network, in bytes. Fits the largest envelope padding bucket. */
export const MAX_REMOTE_TEXT = 65536
export const PeerName = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_PEER_NAME - 1}}$`),
    `Peer names are 1 to ${MAX_PEER_NAME} characters: lowercase letters, digits and hyphens.`,
  )
export const PeerKind = z.enum(PEER_KINDS)

/** Another user's agent on this daemon's network: `<agent>@<member>`. Both halves follow the peer name rules. */
export const RemoteAddress = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_PEER_NAME - 1}}@[a-z0-9][a-z0-9-]{0,${MAX_PEER_NAME - 1}}$`),
    'A remote address is <agent>@<member>, each part a peer name.',
  )

/** The two halves of `<agent>@<member>`. Without an `@`, the whole is the agent and the member is empty. */
export function splitAddress(address: string): { agent: string; member: string } {
  const at = address.indexOf('@')
  return at < 0 ? { agent: address, member: '' } : { agent: address.slice(0, at), member: address.slice(at + 1) }
}
/** A local peer name or a remote address. */
export const Address = z.union([PeerName, RemoteAddress])

/**
 * What the user lets a member's agents do here without asking, set with `net allow`. `ask`: nothing. `chat`:
 * answer from what the agent already knows. `work`: also read files and run read-only commands in its folder.
 * Guidance for the receiving agent, which judges each request against it; never enforcement.
 */
export const AllowLevel = z.enum(['ask', 'chat', 'work'])

/** Whether a level set with `--agents` reaches `agent`. No list: it reaches every shared agent. */
export const levelCovers = (agents: readonly string[] | undefined, agent: string): boolean => agents === undefined || agents.includes(agent)

/** Where a message from another user's agent came from, as this daemon's network link checked it. */
export const Origin = z.object({
  network: z.string(),
  member: PeerName,
  /** True once the user compared the member's fingerprint. False: the host could have swapped keys and read it. */
  keyVerified: z.boolean(),
  /** The member's level when the message arrived. Only a verified key can hold more than `ask`. */
  allow: AllowLevel.default('ask'),
})

export const Message = z.object({
  id: z.string(),
  /**
   * A peer name, or `<agent>@<member>` for another user's agent. Validated because adapters put it into a reply
   * command the agent runs in a shell.
   */
  from: Address,
  /** A local peer, or `<agent>@<member>` while the message waits in the network outbox. */
  to: Address,
  text: z.string(),
  ts: z.string(),
  /** True when the daemon checked that the sending session holds `from`. Absent or false: unverified. */
  verified: z.boolean().optional(),
  /** Set on messages from another user's agent. `from` is then `<agent>@<member>`. */
  origin: Origin.optional(),
})

/** A named participant. `session` is the agent session the name is bound to, if any. */
export const Peer = z.object({
  name: PeerName,
  kind: PeerKind,
  session: z.string().nullable(),
  joinedAt: z.string(),
  /** Last listen, ack, drain or claim. Idle peers are pruned after a day, or a week with mail queued. */
  lastSeen: z.string().optional(),
  /** Assigned by `claim`. Only its own session may listen on it. */
  auto: z.boolean().optional(),
  /** The session that held it before `leave`, so a rejoin gets the same name. */
  lastSession: z.string().optional(),
  /** The folder the session joined from, so peers in the same project can find each other. */
  folder: z.string().optional(),
  /** Reachable by other members of the network. Opt-in per session: cleared when another session binds the name. */
  shared: z.boolean().optional(),
})

/** A push endpoint saved to disk so it survives a daemon restart. Only endpoints with no credential are saved. */
export const SavedEndpoint = z.object({ session: z.string().min(1), kind: PeerKind, endpoint: z.record(z.string(), z.string()) })

/** `agent-bridge net <sub>`, as sent to the daemon. */
export const NetCommand = z.discriminatedUnion('cmd', [
  /**
   * `url`: the address of a tunnel the user runs, which forwards to a port (held by the keeper) or, with
   * `socket`, to the daemon's socket file. `tunnel`: start a trial quick tunnel instead.
   */
  z.object({
    cmd: z.literal('host'),
    name: z.string().trim().min(1).max(64),
    handle: PeerName,
    port: z.number().int().min(0).max(65535),
    url: z.string().min(1).optional(),
    tunnel: z.literal('cloudflared').optional(),
    socket: z.boolean().default(false),
  })
    .refine(c => (c.url === undefined) !== (c.tunnel === undefined), 'host needs exactly one of `url` or `tunnel`.')
    .refine(c => !c.socket || c.url !== undefined, '`socket` goes with `url`: a trial tunnel needs a port.'),
  z.object({ cmd: z.literal('invite'), ttlMs: z.number().int().min(60_000).max(7 * 24 * 3600_000), handle: PeerName.optional() }),
  z.object({ cmd: z.literal('connect'), invite: z.string().min(1).max(4096), handle: PeerName.optional() }),
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('fingerprint') }),
  z.object({ cmd: z.literal('verify'), handle: PeerName, code: z.string().min(1).max(200) }),
  z.object({ cmd: z.literal('trust'), handle: PeerName }),
  /** Set what a member's agents may do here without asking. `forMs`: drop back to `ask` after that long. */
  z.object({
    cmd: z.literal('allow'),
    handle: PeerName,
    level: AllowLevel,
    forMs: z.number().int().min(60_000).max(30 * 24 * 3600_000).optional(),
    /** The local agents the level covers. Absent: every shared agent. */
    agents: z.array(PeerName).min(1).max(64).optional(),
  }),
  z.object({ cmd: z.literal('kick'), handle: PeerName }),
  z.object({ cmd: z.literal('leave') }),
  z.object({ cmd: z.literal('stop') }),
  /** Host: move to `url`. Guest: apply the host's signed update, or a raw `url` with `unsigned`. */
  z.object({ cmd: z.literal('set-url'), value: z.string().min(1).max(4096), unsigned: z.boolean().default(false) }),
])

export const Request = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('listen'),
    /** Omit to listen on whatever name the session holds, waiting for `claim` if it holds none yet. */
    as: PeerName.optional(),
    kind: PeerKind,
    session: z.string().min(1).optional(),
    stream: z.boolean(),
  }).refine(r => r.as !== undefined || r.session !== undefined, 'listen needs `as` or `session`.'),
  /**
   * Bind a name to a session. With `name`: that name, taking it over unless it is another session's auto name.
   * Without: the session's auto name, `<folder>-<kind>` or the lowest free `-<n>`. `folder` is the folder the
   * session joins from, recorded on the peer.
   */
  z.object({
    op: z.literal('claim'),
    folder: z.string().min(1).optional(),
    name: PeerName.optional(),
    kind: PeerKind,
    session: z.string().min(1),
    /** Take `name` even if another session is online with it. Without it, an online name is refused. */
    take: z.boolean().optional(),
  }).refine(r => r.name !== undefined || r.folder !== undefined, 'claim needs a `name` or a `folder`.'),
  /**
   * `sessions`: the sender's agent session ids. With them, `from` must be a name one of them holds.
   * `toKind` instead of `to`: the one online peer of that kind that joined from `folder`.
   */
  z.object({
    op: z.literal('send'),
    from: PeerName,
    /** A local peer or `<agent>@<member>` on the network. */
    to: Address.optional(),
    toKind: PeerKind.optional(),
    folder: z.string().min(1).optional(),
    text: z.string().trim().min(1),
    sessions: z.array(z.string().min(1)).optional(),
  })
    .refine(r => (r.to === undefined) !== (r.toKind === undefined), 'send needs exactly one of `to` or `toKind`.')
    .refine(r => r.toKind === undefined || r.folder !== undefined, 'send with `toKind` needs a `folder`.'),
  z.object({ op: z.literal('ack'), as: PeerName, id: z.string() }),
  z.object({ op: z.literal('drain'), session: z.string().min(1) }),
  z.object({ op: z.literal('ack-drained'), session: z.string().min(1), ids: z.array(z.string()) }),
  z.object({ op: z.literal('leave'), as: PeerName }),
  /**
   * Register a way to push messages into the session itself, e.g. agy's `agentapi send-message`. The endpoint
   * is adapter-defined and may hold a credential, so the daemon never shows it. It keeps it in memory only,
   * unless the adapter defines `alive` (credential-free endpoints): then it is saved to restore after a restart.
   */
  z.object({
    op: z.literal('push'),
    kind: PeerKind,
    session: z.string().min(1),
    endpoint: z.record(z.string(), z.string()),
  }),
  /** Share a peer on the network, or stop. Only a session that holds the name may change it. */
  z.object({ op: z.literal('share'), as: PeerName, sessions: z.array(z.string().min(1)).min(1), on: z.boolean() }),
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('shutdown') }),
  /** A network command. Answered by the daemon's network service, never by the hub. */
  /** `sessions`: the agent sessions of the calling shell, so the daemon can refuse what only the user may do. */
  z.object({ op: z.literal('net'), cmd: NetCommand, sessions: z.array(z.string()).optional() }),
])

/** A member as `net status` shows it. */
export const NetMemberInfo = z.object({
  handle: PeerName,
  fingerprint: z.string(),
  verified: z.boolean(),
  changed: z.boolean(),
  online: z.boolean(),
  host: z.boolean(),
  self: z.boolean(),
  /** What this member's agents may do here without asking, now. */
  allow: AllowLevel.default('ask'),
  /** When `allow` drops back to `ask`, if it does. */
  allowUntil: z.iso.datetime().optional(),
  /** The local agents `allow` covers. Absent: every shared agent. */
  allowAgents: z.array(PeerName).optional(),
})

/** What `net status` reports. No network: `role: 'none'`. */
export const NetInfo = z.object({
  role: z.enum(['none', 'host', 'member']),
  network: z.string().optional(),
  handle: PeerName.optional(),
  url: z.string().optional(),
  /** Host: the local port the tunnel forwards to, held by the keeper. */
  port: z.number().optional(),
  /** Host with `--socket`: the socket file the tunnel forwards to. */
  socket: z.string().optional(),
  connected: z.boolean().optional(),
  state: z.enum(['active', 'revoked', 'left']).optional(),
  fingerprint: z.string().optional(),
  members: z.array(NetMemberInfo).default([]),
  /** Host: the address is a trial quick tunnel, which changes when it restarts. */
  trial: z.boolean().optional(),
  /** Host: the signed line a cut-off member pastes into `net set-url`. */
  urlUpdate: z.string().optional(),
})

export const PeerStatus = Peer.extend({ online: z.boolean(), queued: z.number() })

/** A shared agent of another member, as this daemon last heard from that member. */
export const RemotePeer = z.object({
  address: RemoteAddress,
  member: PeerName,
  kind: PeerKind,
  online: z.boolean(),
  keyVerified: z.boolean(),
  /** Set when the member's key changed and the user has not trusted the new one. Sends are refused. */
  blocked: z.boolean().default(false),
})
export const NetworkStatus = z.object({ name: z.string(), self: PeerName, connected: z.boolean(), outbox: z.number() })

export const Reply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('msg'), msg: Message }),
  z.object({ type: z.literal('superseded'), by: z.string() }),
  z.object({ type: z.literal('stopped') }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('claimed'), name: PeerName }),
  /** `listening`: other peers online now, filled when the recipient is not, so the sender can redirect. */
  /** `pushed`: handed to a push endpoint; it arrives unless that delivery fails, then it waits in the queue. */
  /** `via: network`: stored in the outbox for another member. `keyVerified` is that member's key state. */
  z.object({
    type: z.literal('sent'),
    to: Address.optional(),
    id: z.string(),
    live: z.boolean(),
    pushed: z.boolean().default(false),
    queued: z.number(),
    listening: z.array(PeerName).default([]),
    via: z.enum(['local', 'network']).default('local'),
    keyVerified: z.boolean().optional(),
  }),
  /** `rejoin`: the session is bound but has no push endpoint (lost on a daemon restart). Set once per daemon run. */
  z.object({ type: z.literal('drained'), msgs: z.array(Message), rejoin: z.boolean().default(false) }),
  z.object({
    type: z.literal('status'),
    pid: z.number(),
    peers: z.array(PeerStatus),
    network: NetworkStatus.optional(),
    remote: z.array(RemotePeer).default([]),
  }),
  z.object({ type: z.literal('ok') }),
  /** The answer to a `net` command: text to print, and the network's state where it helps. */
  z.object({ type: z.literal('net'), text: z.string(), info: NetInfo.optional() }),
])

export type PeerKind = z.infer<typeof PeerKind>
export type Message = z.infer<typeof Message>
export type Peer = z.infer<typeof Peer>
export type SavedEndpoint = z.infer<typeof SavedEndpoint>
export type PeerStatus = z.infer<typeof PeerStatus>
export type RemotePeer = z.infer<typeof RemotePeer>
export type NetworkStatus = z.infer<typeof NetworkStatus>
export type Origin = z.infer<typeof Origin>
export type AllowLevel = z.infer<typeof AllowLevel>
export type Request = z.infer<typeof Request>
export type NetCommand = z.infer<typeof NetCommand>
export type NetInfo = z.infer<typeof NetInfo>
export type NetMemberInfo = z.infer<typeof NetMemberInfo>
export type Reply = z.infer<typeof Reply>
export type ReplyOf<T extends Reply['type']> = Extract<Reply, { type: T }>
/** How a stream listener ended: taken over, left, or failed. */
export type StreamEnd = ReplyOf<'superseded' | 'stopped' | 'error'>
