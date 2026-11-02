import { z } from 'zod'

export const PEER_KINDS = ['claude', 'agy', 'opencode'] as const

export const MAX_PEER_NAME = 32
export const PeerName = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_PEER_NAME - 1}}$`),
    `Peer names are 1 to ${MAX_PEER_NAME} characters: lowercase letters, digits and hyphens.`,
  )
export const PeerKind = z.enum(PEER_KINDS)

export const Message = z.object({
  id: z.string(),
  from: z.string(),
  to: PeerName,
  text: z.string(),
  ts: z.string(),
  /** True when the daemon checked that the sending session holds `from`. Absent or false: unverified. */
  verified: z.boolean().optional(),
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
})

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
   * Bind a name to a session. With `folder`: the session's auto name, `<folder>-<kind>` or the lowest free
   * `-<n>`. With `name`: that name, taking it over unless it is another session's auto name.
   */
  z.object({
    op: z.literal('claim'),
    folder: z.string().min(1).optional(),
    name: PeerName.optional(),
    kind: PeerKind,
    session: z.string().min(1),
    /** Take `name` even if another session is online with it. Without it, an online name is refused. */
    take: z.boolean().optional(),
  }).refine(r => (r.folder === undefined) !== (r.name === undefined), 'claim needs exactly one of `folder` or `name`.'),
  /** `sessions`: the sender's agent session ids. With them, `from` must be a name one of them holds. */
  z.object({ op: z.literal('send'), from: PeerName, to: PeerName, text: z.string().trim().min(1), sessions: z.array(z.string().min(1)).optional() }),
  z.object({ op: z.literal('ack'), as: PeerName, id: z.string() }),
  z.object({ op: z.literal('drain'), session: z.string().min(1) }),
  z.object({ op: z.literal('ack-drained'), session: z.string().min(1), ids: z.array(z.string()) }),
  z.object({ op: z.literal('leave'), as: PeerName }),
  /**
   * Register a way to push messages into the session itself, e.g. agy's `agentapi send-message`. The endpoint
   * is adapter-defined and may hold a credential, so the daemon keeps it in memory only and never shows it.
   */
  z.object({ op: z.literal('push'), kind: PeerKind, session: z.string().min(1), endpoint: z.record(z.string(), z.string()) }),
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('shutdown') }),
])

export const PeerStatus = Peer.extend({ online: z.boolean(), queued: z.number() })

export const Reply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('msg'), msg: Message }),
  z.object({ type: z.literal('superseded'), by: z.string() }),
  z.object({ type: z.literal('stopped') }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('claimed'), name: PeerName }),
  /** `listening`: other peers online now, filled when the recipient is not, so the sender can redirect. */
  /** `pushed`: handed to a push endpoint; it arrives unless that delivery fails, then it waits in the queue. */
  z.object({ type: z.literal('sent'), id: z.string(), live: z.boolean(), pushed: z.boolean().default(false), queued: z.number(), listening: z.array(PeerName).default([]) }),
  /** `rejoin`: the session is bound but has no push endpoint (lost on a daemon restart). Set once per daemon run. */
  z.object({ type: z.literal('drained'), msgs: z.array(Message), rejoin: z.boolean().default(false) }),
  z.object({ type: z.literal('status'), pid: z.number(), peers: z.array(PeerStatus) }),
  z.object({ type: z.literal('ok') }),
])

export type PeerKind = z.infer<typeof PeerKind>
export type Message = z.infer<typeof Message>
export type Peer = z.infer<typeof Peer>
export type PeerStatus = z.infer<typeof PeerStatus>
export type Request = z.infer<typeof Request>
export type Reply = z.infer<typeof Reply>
export type ReplyOf<T extends Reply['type']> = Extract<Reply, { type: T }>
/** How a stream listener ended: taken over, left, or failed. */
export type StreamEnd = ReplyOf<'superseded' | 'stopped' | 'error'>
