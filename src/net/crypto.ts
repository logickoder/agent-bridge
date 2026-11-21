import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  getCiphers,
  hkdfSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto'

/**
 * Crypto primitives for networks, on node:crypto only. Keys travel and rest as raw 32-byte values.
 * Nothing here does I/O. See docs/decisions.md, Networks, for the constructions built on these.
 */

export const KEY_BYTES = 32
export const TAG_BYTES = 16
export const NONCE_BYTES = 12
const AEAD = 'chacha20-poly1305'

// DER prefixes that wrap a raw 32-byte key as PKCS8 (private) or SPKI (public).
const DER = {
  x25519: { priv: Buffer.from('302e020100300506032b656e04220420', 'hex'), pub: Buffer.from('302a300506032b656e032100', 'hex') },
  ed25519: { priv: Buffer.from('302e020100300506032b657004220420', 'hex'), pub: Buffer.from('302a300506032b6570032100', 'hex') },
} as const
type Curve = keyof typeof DER

export interface RawKeyPair {
  pub: Buffer
  priv: Buffer
}

export const b64u = {
  encode: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url'),
}

/** Throws at startup if this Node build lacks the AEAD. */
export function assertSupported(): void {
  if (!getCiphers().includes(AEAD)) throw new Error(`This Node build has no ${AEAD}. Networks need it. Install an official Node 22 or newer build.`)
}

function checkLength(b: Uint8Array, what: string): void {
  if (b.length !== KEY_BYTES) throw new Error(`${what} must be ${KEY_BYTES} bytes, got ${b.length}.`)
}

function privateKey(curve: Curve, raw: Uint8Array): KeyObject {
  checkLength(raw, `${curve} private key`)
  return createPrivateKey({ key: Buffer.concat([DER[curve].priv, raw]), format: 'der', type: 'pkcs8' })
}

function publicKey(curve: Curve, raw: Uint8Array): KeyObject {
  checkLength(raw, `${curve} public key`)
  return createPublicKey({ key: Buffer.concat([DER[curve].pub, raw]), format: 'der', type: 'spki' })
}

function rawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(-KEY_BYTES)
}

function generate(curve: Curve): RawKeyPair {
  const { publicKey: pub, privateKey: priv } = curve === 'x25519' ? generateKeyPairSync('x25519') : generateKeyPairSync('ed25519')
  return { pub: rawPublic(pub), priv: priv.export({ format: 'der', type: 'pkcs8' }).subarray(-KEY_BYTES) }
}

export const generateX25519 = (): RawKeyPair => generate('x25519')
export const generateEd25519 = (): RawKeyPair => generate('ed25519')

/** The public key for a raw private key. */
export function publicOf(curve: Curve, priv: Uint8Array): Buffer {
  return rawPublic(createPublicKey(privateKey(curve, priv)))
}

const LOW_ORDER = 'X25519 produced an all-zero secret. The peer key is invalid.'

/** X25519. Rejects an all-zero result, which a low-order public key produces. */
export function dh(priv: Uint8Array, pub: Uint8Array): Buffer {
  const privKey = privateKey('x25519', priv)
  const pubKey = publicKey('x25519', pub)
  let out: Buffer
  try {
    out = diffieHellman({ privateKey: privKey, publicKey: pubKey })
  } catch {
    // OpenSSL 3 refuses the all-zero result itself. Older builds return it, so the check below stays.
    throw new Error(LOW_ORDER)
  }
  if (timingSafeEqual(out, Buffer.alloc(KEY_BYTES))) throw new Error(LOW_ORDER)
  return out
}

export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, length = KEY_BYTES): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, typeof info === 'string' ? Buffer.from(info) : info, length))
}

/** AEAD seal. Returns ciphertext followed by the 16-byte tag. The caller owns nonce uniqueness per key. */
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const c = createCipheriv(AEAD, key, nonce, { authTagLength: TAG_BYTES })
  c.setAAD(aad, { plaintextLength: plaintext.length })
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}

/** AEAD open. Throws on any tampering. Only the returned buffer is authenticated. */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Sealed data is shorter than its tag.')
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES)
  const d = createDecipheriv(AEAD, key, nonce, { authTagLength: TAG_BYTES })
  d.setAAD(aad, { plaintextLength: ct.length })
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  const pt = d.update(ct)
  return Buffer.concat([pt, d.final()])
}

export function sign(priv: Uint8Array, data: Uint8Array): Buffer {
  return edSign(null, data, privateKey('ed25519', priv))
}

export function verify(pub: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    return edVerify(null, data, publicKey('ed25519', pub), sig)
  } catch {
    return false
  }
}

export const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest()

/** Length-prefixed concatenation, so distinct field lists never encode to the same bytes. */
export function concat(...parts: (Uint8Array | string)[]): Buffer {
  const out: Buffer[] = []
  for (const p of parts) {
    const b = typeof p === 'string' ? Buffer.from(p) : Buffer.from(p)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    out.push(len, b)
  }
  return Buffer.concat(out)
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** A member's fingerprint: sha256 over both public keys, first 20 bytes in base32, groups of four. For reading aloud. */
export function fingerprint(x: Uint8Array, e: Uint8Array): string {
  const bytes = sha256(concat(x, e)).subarray(0, 20)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  const groups: string[] = []
  for (let i = 0; i < out.length; i += 4) groups.push(out.slice(i, i + 4))
  return groups.join('-')
}
