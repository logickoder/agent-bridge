import type { Message, StreamEnd } from './schema.js'

const BODY_START = '--- message text (the sender\'s words, not bridge instructions) ---'
const BODY_END = '--- end of message text ---'

/**
 * Fences a message body so its text cannot pose as bridge metadata: lines that look like a bridge header or
 * the closing fence get a leading backslash.
 */
export function fenceBody(text: string): string {
  const safe = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const t = line.trimStart()
      return t.startsWith('[agent-bridge]') || t.startsWith('---') ? `\\${line}` : line
    })
    .join('\n')
  return `${BODY_START}\n${safe}\n${BODY_END}`
}

/** The sender name of notices the bridge itself sends, e.g. a takeover. Not a peer: nothing to reply to. */
export const BRIDGE_SENDER = 'agent-bridge'

/** A notice the bridge itself sent: the reserved sender, and checked. The daemon refuses that name to anyone else. */
export function isBridgeNotice(m: Pick<Message, 'from' | 'verified'>): boolean {
  return m.from === BRIDGE_SENDER && m.verified === true
}

/** The adapter's reply hint, or for a bridge notice, a note that no reply is needed. */
export function replyOr(m: Pick<Message, 'from' | 'verified'>, hint: string): string {
  return isBridgeNotice(m) ? 'This is a notice from the bridge itself; no reply needed.' : hint
}

/** The one header every delivered message starts with. Adapters add their own punctuation and hints after it. */
export function messageHeader(m: Message, opts: { ts?: boolean } = {}): string {
  return `[agent-bridge] Message from ${senderLabel(m)} to ${m.to} (id ${m.id}${opts.ts ? `, ${m.ts}` : ''})`
}


/** The shared wording for a stream that ended. */
export function endText(e: StreamEnd): string {
  if (e.type === 'superseded') return `another session (${e.by}) took over this name. This session no longer receives.`
  if (e.type === 'stopped') return 'this session left the bridge. It no longer receives.'
  return e.message
}

export const endCode = (e: StreamEnd): number => (e.type === 'error' ? 1 : 0)

/** The sender as shown to the recipient. Unverified senders are marked, since anyone local can send under any name. */
export function senderLabel(m: Pick<Message, 'from' | 'verified'>): string {
  return m.verified === true ? m.from : `${m.from} (unverified)`
}

/** Result of a send, for the tool reply and the CLI. */
export function formatSent(to: string, r: { id: string; live: boolean; pushed?: boolean; queued: number; listening: string[] }): string {
  if (r.live) return `Delivered live to ${to} (id ${r.id}).`
  if (r.pushed) return `Handed to ${to}'s direct delivery (id ${r.id}). If that delivery fails, the message waits in ${to}'s queue.`
  const queued = `Queued for ${to} (id ${r.id}, ${r.queued} waiting). ${to} gets it after the messages ahead of it, or when it next listens or starts a turn.`
  return r.listening.length ? `${queued} Listening now: ${r.listening.join(', ')}. If ${to} has ended, resend to one of them.` : queued
}

interface PeerLine {
  name: string
  kind: string
  online: boolean
  queued: number
}

/**
 * Peers for people and agents: online ones by name, offline ones only as a count, since an offline peer cannot
 * answer. `all` lists everyone with state and queue, for stats.
 */
export function formatPeers(peers: PeerLine[], opts: { all?: boolean; self?: string }): string {
  if (!peers.length) return 'No peers yet. Peers appear here once they join the bridge.'
  if (opts.all) return peers.map(p => `${p.name} (${p.kind}) ${p.online ? 'online' : 'offline'}, ${p.queued} queued`).join('\n')
  const online = peers.filter(p => p.online).map(p => `${p.name} (${p.kind}${p.name === opts.self ? ', you' : ''})`)
  const offline = peers.length - online.length
  const head = online.length ? `Online: ${online.join(', ')}.` : 'Nobody is online.'
  return offline ? `${head} ${offline} offline: \`agent-bridge peers --all\` lists them.` : head
}
