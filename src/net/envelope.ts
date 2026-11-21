import { b64u, concat, dh, generateX25519, hkdf, NONCE_BYTES, open, seal } from './crypto.js'
import { NET_VERSION, type Envelope } from './schema.js'

/**
 * Member-to-member encryption. The host routes these by handle and cannot read them.
 * Key per message: HKDF(DH(ephemeral, recipient) || DH(sender static, recipient)). The static term
 * authenticates the sender to the recipient, who checks it against the pinned key, never the directory's.
 * Limits, documented in docs/concepts.md: no forward secrecy if the recipient's static key leaks, and a
 * stolen recipient key can forge senders to that recipient (KCI).
 */

/** Plaintext is padded up to one of these sizes, so lengths reveal little. */
const MAX_BUCKET = 131072
export const PAD_BUCKETS = [256, 1024, 4096, 16384, 65536, MAX_BUCKET] as const
const LEN_BYTES = 4
export const MAX_PLAINTEXT = MAX_BUCKET - LEN_BYTES
const ZERO_NONCE = Buffer.alloc(NONCE_BYTES)

export interface Route {
  netId: string
  from: string
  to: string
}

export interface SealInput extends Route {
  /** Sender static X25519. */
  senderPriv: Uint8Array
  senderPub: Uint8Array
  recipientPub: Uint8Array
  /** 16 random bytes, fixed per message so a retry is recognised as the same one. */
  id: Uint8Array
  plaintext: Uint8Array
}

export interface OpenInput extends Route {
  recipientPriv: Uint8Array
  recipientPub: Uint8Array
  /** The sender's pinned static key. */
  senderPub: Uint8Array
  envelope: Envelope
}

export function pad(plaintext: Uint8Array): Buffer {
  const need = plaintext.length + LEN_BYTES
  const size = PAD_BUCKETS.find(b => b >= need)
  if (size === undefined) throw new Error(`Message is ${plaintext.length} bytes. The limit is ${MAX_PLAINTEXT}. Send less.`)
  const out = Buffer.alloc(size)
  out.writeUInt32BE(plaintext.length, 0)
  Buffer.from(plaintext).copy(out, LEN_BYTES)
  return out
}

export function unpad(padded: Uint8Array): Buffer {
  const b = Buffer.from(padded)
  if (b.length < LEN_BYTES) throw new Error('Padded message is too short.')
  const len = b.readUInt32BE(0)
  if (len > b.length - LEN_BYTES) throw new Error('Padded message length is out of range.')
  return b.subarray(LEN_BYTES, LEN_BYTES + len)
}

function key(ikm: Buffer, ePub: Uint8Array, senderPub: Uint8Array, recipientPub: Uint8Array, r: Route): Buffer {
  return hkdf(ikm, Buffer.concat([ePub, senderPub, recipientPub]), concat('ab/v1/e2e', r.netId, r.from, r.to))
}

const aadFor = (r: Route, id: string, e: string): Buffer => concat(String(NET_VERSION), r.netId, r.from, r.to, id, e)

export function sealEnvelope(input: SealInput): Envelope {
  const eph = generateX25519()
  const ikm = Buffer.concat([dh(eph.priv, input.recipientPub), dh(input.senderPriv, input.recipientPub)])
  const k = key(ikm, eph.pub, input.senderPub, input.recipientPub, input)
  const id = b64u.encode(input.id)
  const e = b64u.encode(eph.pub)
  return { v: NET_VERSION, id, e, c: b64u.encode(seal(k, ZERO_NONCE, pad(input.plaintext), aadFor(input, id, e))) }
}

/** Opens an envelope. Throws if it was not sealed by the pinned sender for this recipient and route. */
export function openEnvelope(input: OpenInput): Buffer {
  const ePub = b64u.decode(input.envelope.e)
  const ikm = Buffer.concat([dh(input.recipientPriv, ePub), dh(input.recipientPriv, input.senderPub)])
  const k = key(ikm, ePub, input.senderPub, input.recipientPub, input)
  const padded = open(k, ZERO_NONCE, b64u.decode(input.envelope.c), aadFor(input, input.envelope.id, input.envelope.e))
  return unpad(padded)
}
