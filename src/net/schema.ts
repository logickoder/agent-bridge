import { z } from 'zod'
import { MAX_REMOTE_TEXT, PeerKind, PeerName } from '../schema.js'

/** Wire and disk formats for networks. Everything that crosses the network or rests in `net/` is validated here. */

export const B64u = z.string().regex(/^[A-Za-z0-9_-]*$/, 'not base64url')
/** A raw 32-byte key, base64url without padding. */
export const Key32 = B64u.length(43)

export const NET_VERSION = 1

export const Invite = z.object({
  v: z.literal(NET_VERSION),
  /** The network's display name. */
  net: z.string().min(1).max(64),
  netId: B64u.min(16).max(64),
  url: z.url(),
  /** Host X25519 and Ed25519 public keys, pinned by the guest. */
  hx: Key32,
  he: Key32,
  token: Key32,
  exp: z.iso.datetime(),
  /** A handle reserved for this invite, e.g. the same person on a new machine. */
  handle: PeerName.optional(),
})

/** Longest envelope ciphertext accepted: the largest padding bucket plus the tag, as base64url. */
export const MAX_ENVELOPE_C = 175_000

/** A member-to-member sealed message. Routing handles come from the outer layer and are bound into the AAD. */
export const Envelope = z.object({
  v: z.literal(NET_VERSION),
  id: B64u.length(22),
  /** The sender's ephemeral X25519 public key. */
  e: Key32,
  c: B64u.min(1).max(MAX_ENVELOPE_C),
})

export type Invite = z.infer<typeof Invite>
export type Envelope = z.infer<typeof Envelope>

// --- Unauthenticated handshakes. Everything secret is inside `c`, sealed to the host's static key. ---

export const JoinReq = z.object({
  v: z.literal(NET_VERSION),
  mx: Key32,
  me: Key32,
  /** 16 random bytes: makes the join key fresh, so its nonce can be fixed. */
  salt: B64u.length(22),
  c: B64u.min(1).max(4096),
})
/** Inside JoinReq.c. `sig`: the member's Ed25519 key over its X25519 key, binding the two. */
export const JoinBody = z.object({ token: Key32, handle: PeerName.optional(), sig: B64u.length(86) })

export const OpenReq = z.object({
  v: z.literal(NET_VERSION),
  mx: Key32,
  /** 16 random bytes from the member. The host adds its own; both go into the session keys. */
  csid: B64u.length(22),
  c: B64u.min(1).max(1024),
})
/** Inside OpenReq.c: proves the member holds its key, now. */
export const OpenBody = z.object({ ts: z.iso.datetime() })
export const OpenRes = z.object({ hsid: B64u.length(22) })

export const Frame = z.object({ n: z.number().int().positive(), c: B64u.min(1).max(MAX_ENVELOPE_C + 4096) })

// --- Directory: who is in the network, signed by the host. ---

export const DirMember = z.object({
  handle: PeerName,
  x: Key32,
  e: Key32,
  /** The member's own signature over its X25519 key, from its join. */
  sig: B64u.length(86),
  online: z.boolean(),
  host: z.boolean(),
})
export const Directory = z.object({
  netId: B64u,
  network: z.string(),
  /** Grows on every membership, key, address or presence change. */
  epoch: z.number().int().nonnegative(),
  url: z.string(),
  urlSeq: z.number().int().nonnegative(),
  members: z.array(DirMember),
  /** Host Ed25519 over everything above. Proves the host sent it, not that the keys are genuine. */
  sig: B64u.length(86),
})

export const JoinReply = z.object({ handle: PeerName, directory: Directory })

// --- Channel RPC, inside outer frames. ---

export const MailKind = z.enum(['msg', 'presence', 'bounce'])
export const RpcOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send'), to: PeerName, t: MailKind, env: Envelope }),
  /** Cumulative: every mailbox entry up to and including `upTo` is done. */
  z.object({ op: z.literal('ack'), upTo: z.number().int().nonnegative() }),
  /** Long-poll for entries after `cursor`. `epoch`: the directory version the member holds. */
  z.object({ op: z.literal('poll'), cursor: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(), waitMs: z.number().int().min(0).max(25_000) }),
  z.object({ op: z.literal('leave') }),
])
export const MailEntry = z.object({ seq: z.number().int().positive(), from: PeerName, t: MailKind, env: Envelope, at: z.iso.datetime() })
export const RpcError = z.enum(['mailbox-full', 'rate', 'unknown-member', 'revoked', 'bad-request'])
export const RpcReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mail: z.array(MailEntry).default([]), directory: Directory.optional() }),
  z.object({ ok: z.literal(false), error: RpcError, retryAfterMs: z.number().int().nonnegative().optional() }),
])

// --- Host state on disk. ---

export const MemberRec = z.object({
  handle: PeerName,
  x: Key32,
  e: Key32,
  sig: B64u.length(86),
  joinedAt: z.iso.datetime(),
})
export const InviteRec = z.object({ hash: z.string(), exp: z.iso.datetime(), used: z.boolean(), handle: PeerName.optional() })
export const HostState = z.object({
  netId: B64u,
  network: z.string(),
  handle: PeerName,
  url: z.string(),
  urlSeq: z.number().int().nonnegative(),
  members: z.array(MemberRec),
  invites: z.array(InviteRec),
  /** Handles of removed members. Never reassigned, unless an invite reserves one on purpose. */
  tombstones: z.array(PeerName),
  /** X25519 keys of removed members, so a reconnect is told it was removed rather than left guessing. */
  revoked: z.array(Key32).default([]),
  /** Members who left on their own. Not banned: the same key rejoining with an invite gets its handle back. */
  departed: z.array(z.object({ handle: PeerName, x: Key32 })).default([]),
})

/** One member's mailbox on the host. `seq` is the last number given out and never goes back, even when empty. */
export const Mailbox = z.object({ seq: z.number().int().nonnegative(), entries: z.array(MailEntry) })

export type JoinReq = z.infer<typeof JoinReq>
export type JoinBody = z.infer<typeof JoinBody>
export type OpenReq = z.infer<typeof OpenReq>
export type OpenRes = z.infer<typeof OpenRes>
export type FrameT = z.infer<typeof Frame>
export type DirMember = z.infer<typeof DirMember>
export type Directory = z.infer<typeof Directory>
export type JoinReply = z.infer<typeof JoinReply>
export type MailKind = z.infer<typeof MailKind>
export type RpcOp = z.infer<typeof RpcOp>
export type MailEntry = z.infer<typeof MailEntry>
export type RpcError = z.infer<typeof RpcError>
export type RpcReply = z.infer<typeof RpcReply>
export type MemberRec = z.infer<typeof MemberRec>
export type InviteRec = z.infer<typeof InviteRec>
export type HostState = z.infer<typeof HostState>

/** A member's shared agents, as it announces them. */
export const PresencePeers = z.array(z.object({ name: PeerName, kind: PeerKind, online: z.boolean() })).max(64)

/** Why a member did not deliver a message: the hub's refusals, or `expired` (outside the replay window). */
export const BounceReason = z.enum(['not-shared', 'invalid-sender', 'busy', 'expired'])
export type BounceReason = z.infer<typeof BounceReason>

/** Inside an envelope: what one member says to another. Only the two members can read it. */
export const Inner = z.discriminatedUnion('t', [
  z.object({ t: z.literal('msg'), from: PeerName, to: PeerName, text: z.string().min(1).max(MAX_REMOTE_TEXT), sentAt: z.iso.datetime() }),
  /** The sender's shared agents. Replaces the last list from that member. */
  z.object({ t: z.literal('presence'), peers: PresencePeers }),
  /**
   * A message could not be delivered. `ref`: its envelope id. The sender only acts on a bounce for a message it
   * really sent to that member, and words the notice itself: the reason is a code, never text from the member.
   */
  z.object({ t: z.literal('bounce'), ref: B64u.length(22), reason: BounceReason }),
])
export type Inner = z.infer<typeof Inner>

/** A member's pinned keys for another member. Pinned on first sight; `verified` only after a fingerprint check. */
export const Pin = z.object({
  x: Key32,
  e: Key32,
  verified: z.boolean(),
  /** The directory now shows other keys for this handle. Nothing goes either way until the user decides. */
  changed: z.object({ x: Key32, e: Key32 }).optional(),
  /**
   * What the user lets this member's agents do here without asking, set with `net allow`. Counts only while the
   * key is verified and unchanged; accepting a new key drops it. `until`: epoch ms when it lapses. `agents`: the
   * local agents it covers; absent means every shared agent.
   */
  allow: z
    .object({ level: z.enum(['chat', 'work']), until: z.number().int().optional(), agents: z.array(PeerName).min(1).max(64).optional() })
    .optional(),
})
export type Pin = z.infer<typeof Pin>

/** What a member keeps about its network between restarts. */
export const LinkState = z.object({
  netId: B64u,
  network: z.string(),
  handle: PeerName,
  url: z.string(),
  urlSeq: z.number().int().nonnegative(),
  /** The host's Ed25519 key, pinned from the invite. Directories and address updates must verify against it. */
  hostE: Key32,
  hostX: Key32,
  /** Highest mailbox seq processed. */
  cursor: z.number().int().nonnegative(),
  pins: z.record(z.string(), Pin),
  /** `<member>:<envelope id>` to when it arrived, kept 8 days, so a replay is dropped. */
  seen: z.record(z.string(), z.number()),
  /** Mail from a member whose key changed, waiting for the user to trust or verify the new key. */
  held: z.array(MailEntry),
  /** Messages sent, by envelope id, kept 8 days: only a bounce for one of these is believed. */
  sent: z.record(z.string(), z.object({ from: PeerName, agent: PeerName, member: PeerName, at: z.number() })).default({}),
  directory: Directory.optional(),
  /** Each member's shared agents, from its last presence. */
  presence: z.record(z.string(), PresencePeers).default({}),
  state: z.enum(['active', 'revoked', 'left']),
})
export type LinkState = z.infer<typeof LinkState>
export type Mailbox = z.infer<typeof Mailbox>

/** This daemon's network keys, at rest. The same keys serve as host and as member. */
export const Identity = z.object({
  v: z.literal(NET_VERSION),
  x: z.object({ pub: Key32, priv: Key32 }),
  e: z.object({ pub: Key32, priv: Key32 }),
})
export type Identity = z.infer<typeof Identity>

/**
 * Host only: how the tunnel reaches this daemon. `port`: a keeper holds 127.0.0.1:port and relays it to the
 * daemon's socket. `socket`: the tunnel points at the socket file itself. `cloudflared`: a keeper holds the port
 * and runs a trial quick tunnel to it.
 */
export const ServerConfig = z.object({
  mode: z.enum(['port', 'socket', 'cloudflared']),
  port: z.number().int().min(0).max(65535),
})
export type ServerConfig = z.infer<typeof ServerConfig>

/** The running keeper, adopted again by the next daemon. `url`: the trial tunnel's address, if it runs one. */
export const KeeperState = z.object({ pid: z.number().int().positive(), port: z.number().int(), url: z.string().optional() })
export type KeeperState = z.infer<typeof KeeperState>

/** The body of POST /v1/rpc: which session, and one sealed frame on it. */
export const RpcWire = z.object({ sid: B64u.length(22), frame: Frame })
export type RpcWire = z.infer<typeof RpcWire>
export const JoinWireReply = z.object({ c: B64u.min(1) })
