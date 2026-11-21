import { describe, expect, it } from 'vitest'
import {
  assertSupported,
  b64u,
  concat,
  dh,
  fingerprint,
  generateEd25519,
  generateX25519,
  hkdf,
  open,
  publicOf,
  seal,
  sign,
  verify,
} from './crypto.js'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ''), 'hex')

describe('X25519 (RFC 7748 6.1)', () => {
  const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
  const alicePub = hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
  const bobPriv = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
  const bobPub = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
  const shared = hex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')

  it('derives the public keys', () => {
    expect(publicOf('x25519', alicePriv)).toEqual(alicePub)
    expect(publicOf('x25519', bobPriv)).toEqual(bobPub)
  })

  it('agrees on the shared secret from both sides', () => {
    expect(dh(alicePriv, bobPub)).toEqual(shared)
    expect(dh(bobPriv, alicePub)).toEqual(shared)
  })

  it('rejects a low-order public key', () => {
    expect(() => dh(alicePriv, Buffer.alloc(32))).toThrow(/all-zero/)
  })

  it('rejects a key of the wrong length', () => {
    expect(() => dh(alicePriv, Buffer.alloc(31, 1))).toThrow(/32 bytes/)
  })
})

describe('HKDF-SHA256 (RFC 5869 A.1)', () => {
  it('matches the test vector', () => {
    const okm = hkdf(Buffer.alloc(22, 0x0b), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42)
    expect(okm).toEqual(hex('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'))
  })
})

describe('ChaCha20-Poly1305 (RFC 8439 2.8.2)', () => {
  const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f')
  const nonce = hex('070000004041424344454647')
  const aad = hex('50515253c0c1c2c3c4c5c6c7')
  const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")

  it('matches the test vector', () => {
    const sealed = seal(key, nonce, pt, aad)
    expect(sealed.subarray(0, 4)).toEqual(hex('d31a8d34'))
    expect(sealed.subarray(-16)).toEqual(hex('1ae10b594f09e26a7e902ecbd0600691'))
    expect(open(key, nonce, sealed, aad)).toEqual(pt)
  })

  it('throws when the ciphertext, tag or AAD is changed', () => {
    const sealed = seal(key, nonce, pt, aad)
    for (const i of [0, sealed.length - 1]) {
      const bad = Buffer.from(sealed)
      bad[i] = (bad[i] ?? 0) ^ 1
      expect(() => open(key, nonce, bad, aad)).toThrow()
    }
    expect(() => open(key, nonce, sealed, Buffer.from('other'))).toThrow()
  })

  it('refuses data shorter than a tag', () => {
    expect(() => open(key, nonce, Buffer.alloc(8), aad)).toThrow(/shorter/)
  })
})

describe('Ed25519 (RFC 8032 7.1 test 1)', () => {
  const priv = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
  const pub = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  const sig = hex(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  )

  it('signs and verifies the empty message', () => {
    expect(publicOf('ed25519', priv)).toEqual(pub)
    expect(sign(priv, Buffer.alloc(0))).toEqual(sig)
    expect(verify(pub, Buffer.alloc(0), sig)).toBe(true)
  })

  it('rejects a changed message or a malformed key', () => {
    expect(verify(pub, Buffer.from('x'), sig)).toBe(false)
    expect(verify(Buffer.alloc(32), Buffer.alloc(0), sig)).toBe(false)
  })
})

describe('helpers', () => {
  it('generates usable key pairs', () => {
    const a = generateX25519()
    const b = generateX25519()
    expect(dh(a.priv, b.pub)).toEqual(dh(b.priv, a.pub))
    const e = generateEd25519()
    expect(verify(e.pub, Buffer.from('m'), sign(e.priv, Buffer.from('m')))).toBe(true)
  })

  it('length-prefixes, so shifted boundaries differ', () => {
    expect(concat('ab', 'c')).not.toEqual(concat('a', 'bc'))
  })

  it('round-trips base64url', () => {
    const b = Buffer.from([0, 255, 62, 63])
    expect(b64u.decode(b64u.encode(b))).toEqual(b)
  })

  it('formats fingerprints as eight groups of four', () => {
    const fp = fingerprint(Buffer.alloc(32, 1), Buffer.alloc(32, 2))
    expect(fp).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    expect(fingerprint(Buffer.alloc(32, 1), Buffer.alloc(32, 3))).not.toBe(fp)
  })

  it('finds the AEAD in this Node build', () => {
    expect(() => assertSupported()).not.toThrow()
  })
})
