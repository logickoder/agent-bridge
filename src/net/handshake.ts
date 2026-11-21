import { Channel, type Role } from './channel.js'
import { b64u, concat, dh, hkdf, NONCE_BYTES, open, seal, sign, verify, type RawKeyPair } from './crypto.js'
import { JoinBody, JoinReply, NET_VERSION, OpenBody, type JoinReq, type OpenReq } from './schema.js'

/**
 * The two handshakes before a channel exists. Both are sealed to the host's static X25519 key, which the member
 * pinned from the invite, so a tunnel in the middle can neither read the token nor pose as the host.
 * Each key is fresh (a random salt or csid goes into it), so a fixed nonce is safe.
 */

export interface StaticKeys {
  x: RawKeyPair
  e: RawKeyPair
}

const ZERO_NONCE = Buffer.alloc(NONCE_BYTES)
const text = (v: unknown): Buffer => Buffer.from(JSON.stringify(v))
const json = (b: Buffer): unknown => JSON.parse(b.toString('utf8'))

/** What a member signs with its Ed25519 key, binding its X25519 key to it within one network. */
export const memberBinding = (netId: string, x: Uint8Array): Buffer => concat('ab/v1/member', netId, x)

export function verifyMemberSig(netId: string, x: Uint8Array, e: Uint8Array, sig: string): boolean {
  return verify(e, memberBinding(netId, x), b64u.decode(sig))
}

function joinKeys(ss: Buffer, salt: Uint8Array, netId: string, mx: Uint8Array, hx: Uint8Array): { key: Buffer; replyKey: Buffer } {
  return {
    key: hkdf(ss, salt, concat('ab/v1/join', netId, mx, hx)),
    replyKey: hkdf(ss, salt, concat('ab/v1/join-reply', netId, mx, hx)),
  }
}

const joinAad = (mx: string, me: string): Buffer => concat('ab/v1/join', mx, me)

export interface JoinInput {
  me: StaticKeys
  netId: string
  hostX: Uint8Array
  token: string
  handle?: string | undefined
  salt: Uint8Array
}

/** Member side. Keep `replyKey` to open the host's answer. */
export function buildJoin(input: JoinInput): { req: JoinReq; replyKey: Buffer } {
  const ss = dh(input.me.x.priv, input.hostX)
  const { key, replyKey } = joinKeys(ss, input.salt, input.netId, input.me.x.pub, input.hostX)
  const mx = b64u.encode(input.me.x.pub)
  const me = b64u.encode(input.me.e.pub)
  const body: JoinBody = {
    token: input.token,
    ...(input.handle !== undefined ? { handle: input.handle } : {}),
    sig: b64u.encode(sign(input.me.e.priv, memberBinding(input.netId, input.me.x.pub))),
  }
  const c = seal(key, ZERO_NONCE, text(body), joinAad(mx, me))
  return { req: { v: NET_VERSION, mx, me, salt: b64u.encode(input.salt), c: b64u.encode(c) }, replyKey }
}

/** Host side. Throws if the request was not sealed to this host or the member's keys are not bound together. */
export function acceptJoin(host: RawKeyPair, netId: string, req: JoinReq): { body: JoinBody; replyKey: Buffer } {
  const mx = b64u.decode(req.mx)
  const ss = dh(host.priv, mx)
  const { key, replyKey } = joinKeys(ss, b64u.decode(req.salt), netId, mx, host.pub)
  const body = JoinBody.parse(json(open(key, ZERO_NONCE, b64u.decode(req.c), joinAad(req.mx, req.me))))
  if (!verifyMemberSig(netId, mx, b64u.decode(req.me), body.sig)) throw new Error('The member signature does not match its keys.')
  return { body, replyKey }
}

export const sealJoinReply = (replyKey: Uint8Array, reply: JoinReply): string =>
  b64u.encode(seal(replyKey, ZERO_NONCE, text(reply), Buffer.from('ab/v1/join-reply')))

/** Member side. Throws unless the reply came from the host the invite named. */
export function openJoinReply(replyKey: Uint8Array, c: string): JoinReply {
  return JoinReply.parse(json(open(replyKey, ZERO_NONCE, b64u.decode(c), Buffer.from('ab/v1/join-reply'))))
}

const openKey = (ss: Buffer, csid: Uint8Array, netId: string, mx: Uint8Array, hx: Uint8Array): Buffer =>
  hkdf(ss, csid, concat('ab/v1/open', netId, mx, hx))

export interface OpenInput {
  me: RawKeyPair
  netId: string
  hostX: Uint8Array
  csid: Uint8Array
  now: Date
}

/** Member side: start a channel session. */
export function buildOpen(input: OpenInput): OpenReq {
  const ss = dh(input.me.priv, input.hostX)
  const mx = b64u.encode(input.me.pub)
  const csid = b64u.encode(input.csid)
  const body = { ts: input.now.toISOString() }
  const c = seal(openKey(ss, input.csid, input.netId, input.me.pub, input.hostX), ZERO_NONCE, text(body), concat('ab/v1/open', mx, csid))
  return { v: NET_VERSION, mx, csid, c: b64u.encode(c) }
}

/**
 * Host side, for a member already looked up by `req.mx`. Returns the static secret for the channel. Throws if
 * the proof fails or its time is off by more than `maxSkewMs`: an old request replayed later is refused.
 */
export function acceptOpen(host: RawKeyPair, netId: string, req: OpenReq, now: Date, maxSkewMs: number): Buffer {
  const mx = b64u.decode(req.mx)
  const ss = dh(host.priv, mx)
  const csid = b64u.decode(req.csid)
  const body = OpenBody.parse(json(open(openKey(ss, csid, netId, mx, host.pub), ZERO_NONCE, b64u.decode(req.c), concat('ab/v1/open', req.mx, req.csid))))
  if (Math.abs(Date.parse(body.ts) - now.getTime()) > maxSkewMs) throw new Error('The open request is too old or from a clock far off.')
  return ss
}

export function channelFor(ss: Uint8Array, csid: string, hsid: string, handle: string, role: Role): Channel {
  return new Channel({ ss, csid: b64u.decode(csid), hsid: b64u.decode(hsid), handle, role })
}
