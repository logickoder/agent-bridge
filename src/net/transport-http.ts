import { randomBytes } from 'node:crypto'
import type { Channel } from './channel.js'
import { b64u, dh } from './crypto.js'
import { buildJoin, buildOpen, channelFor, openJoinReply, type StaticKeys } from './handshake.js'
import type { Transport } from './link.js'
import { RPC_PATH, RPC_REPLY_PATH } from './relay.js'
import { Frame, JoinWireReply, OpenRes, RpcReply, type Invite, type JoinReply, type RpcOp } from './schema.js'

/**
 * A member's way to the host over HTTP: open a session, then sealed RPCs on it. Long-poll only, so it works
 * through any tunnel, including ones without SSE. Throws when the host cannot be reached; the link backs off.
 */

/** Added to a poll's hold, for the round trip through the tunnel. */
const POLL_SLACK_MS = 20_000
const CALL_TIMEOUT_MS = 30_000

type Post = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; body: unknown }>

const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`

/** POSTs JSON. Throws on a network failure or timeout; any HTTP status is an answer. */
const postJson: Post = async (url, body, timeoutMs) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

export interface HttpTransportInit {
  url: string
  keys: StaticKeys
  hostX: Uint8Array
  netId: string
  handle: string
  now: () => Date
  post?: Post
}

interface Session {
  sid: string
  ch: Channel
}

export class HttpTransport implements Transport {
  private url: string
  private sess: Session | undefined
  private opening: Promise<Session | 'revoked'> | undefined
  private readonly post: Post

  constructor(private readonly init: HttpTransportInit) {
    this.url = init.url
    this.post = init.post ?? postJson
  }

  setUrl(url: string): void {
    this.url = url
    this.sess = undefined
  }

  async call(op: RpcOp): Promise<RpcReply> {
    const timeout = op.op === 'poll' ? op.waitMs + POLL_SLACK_MS : CALL_TIMEOUT_MS
    for (let attempt = 0; attempt < 2; attempt++) {
      const sess = this.sess ?? (await this.openOnce())
      if (sess === 'revoked') return { ok: false, error: 'revoked' }
      const frame = sess.ch.seal(RPC_PATH, Buffer.from(JSON.stringify(op)))
      const res = await this.post(join(this.url, RPC_PATH), { sid: sess.sid, frame }, timeout)
      if (res.status === 401) {
        // The host restarted or dropped the session. Open a new one and try once more.
        if (this.sess === sess) this.sess = undefined
        continue
      }
      if (res.status !== 200) throw new Error(`the host answered ${res.status}`)
      const reply = Frame.parse(res.body)
      return RpcReply.parse(JSON.parse(sess.ch.open(RPC_REPLY_PATH, reply).toString('utf8')))
    }
    throw new Error('the host keeps refusing the session')
  }

  /** One open at a time: a poll and a send starting together share it. */
  private openOnce(): Promise<Session | 'revoked'> {
    this.opening ??= this.open().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  private async open(): Promise<Session | 'revoked'> {
    const csid = randomBytes(16)
    const req = buildOpen({ me: this.init.keys.x, netId: this.init.netId, hostX: this.init.hostX, csid, now: this.init.now() })
    const res = await this.post(join(this.url, '/v1/open'), req, CALL_TIMEOUT_MS)
    if (res.status === 403) return 'revoked'
    if (res.status !== 200) throw new Error(`the host refused a session (${res.status})`)
    const { hsid } = OpenRes.parse(res.body)
    const ch = channelFor(dh(this.init.keys.x.priv, this.init.hostX), b64u.encode(csid), hsid, this.init.handle, 'member')
    this.sess = { sid: ch.sid, ch }
    return this.sess
  }
}

/** A fetch failure's real reason: undici puts it in `cause` (ENOTFOUND, ECONNREFUSED, a TLS error). */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause: unknown = err.cause
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message
}

/** Redeems an invite at the host. Returns the handle and the first directory. */
export async function joinOverHttp(invite: Invite, keys: StaticKeys, handle: string | undefined, post: Post = postJson): Promise<JoinReply> {
  const { req, replyKey } = buildJoin({ me: keys, netId: invite.netId, hostX: b64u.decode(invite.hx), token: invite.token, handle, salt: randomBytes(16) })
  let res: { status: number; body: unknown }
  try {
    res = await post(join(invite.url, '/v1/join'), req, CALL_TIMEOUT_MS)
  } catch (err) {
    throw new Error(
      `Could not reach the host at ${invite.url}: ${reason(err)}. Check that the host's daemon and tunnel are running, then try again.`,
    )
  }
  if (res.status === 403) {
    throw new Error('The host removed this machine from the network, so a plain invite does not work. Ask the host for one reserved for you: `agent-bridge net invite --handle <your handle>`.')
  }
  if (res.status !== 200) {
    throw new Error('The host refused the invite. It may be used, expired, or from another network. Ask the host for a new one with `agent-bridge net invite`.')
  }
  try {
    return openJoinReply(replyKey, JoinWireReply.parse(res.body).c)
  } catch {
    throw new Error(`The answer from ${invite.url} did not come from the host the invite names. Someone may be in the way. Do not retry with this address; ask the host.`)
  }
}
