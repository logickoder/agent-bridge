import { describe, expect, it } from 'vitest'
import { b64u, generateX25519 } from './crypto.js'
import { MAX_PLAINTEXT, openEnvelope, pad, PAD_BUCKETS, sealEnvelope, unpad } from './envelope.js'

const alice = generateX25519()
const bob = generateX25519()
const eve = generateX25519()
const route = { netId: 'net-0123456789abcdef', from: 'alice', to: 'bob' }
const text = Buffer.from('PAPAYA-SECRET-42')

const sealed = () =>
  sealEnvelope({ ...route, senderPriv: alice.priv, senderPub: alice.pub, recipientPub: bob.pub, id: Buffer.alloc(16, 9), plaintext: text })
const opener = { ...route, recipientPriv: bob.priv, recipientPub: bob.pub, senderPub: alice.pub }

describe('envelope', () => {
  it('round-trips and hides the plaintext', () => {
    const env = sealed()
    expect(openEnvelope({ ...opener, envelope: env })).toEqual(text)
    expect(b64u.decode(env.c).includes(text)).toBe(false)
  })

  it('uses a fresh ephemeral key per message', () => {
    expect(sealed().e).not.toBe(sealed().e)
  })

  it('fails for the wrong recipient', () => {
    expect(() => openEnvelope({ ...opener, recipientPriv: eve.priv, recipientPub: eve.pub, envelope: sealed() })).toThrow()
  })

  it('fails when the host swaps the sender handle', () => {
    expect(() => openEnvelope({ ...opener, from: 'carol', envelope: sealed() })).toThrow()
  })

  it('fails when the sender key is not the pinned one', () => {
    const forged = sealEnvelope({ ...route, senderPriv: eve.priv, senderPub: eve.pub, recipientPub: bob.pub, id: Buffer.alloc(16), plaintext: text })
    expect(() => openEnvelope({ ...opener, envelope: forged })).toThrow()
  })

  it('fails when the id is changed', () => {
    const env = sealed()
    expect(() => openEnvelope({ ...opener, envelope: { ...env, id: b64u.encode(Buffer.alloc(16, 1)) } })).toThrow()
  })
})

describe('padding', () => {
  it('pads to the smallest bucket that fits, and unpads', () => {
    expect(pad(Buffer.alloc(10)).length).toBe(256)
    expect(pad(Buffer.alloc(253)).length).toBe(1024)
    expect(unpad(pad(text))).toEqual(text)
  })

  it('refuses a message over the limit', () => {
    expect(() => pad(Buffer.alloc(MAX_PLAINTEXT + 1))).toThrow(/limit/)
    expect(pad(Buffer.alloc(MAX_PLAINTEXT)).length).toBe(PAD_BUCKETS[PAD_BUCKETS.length - 1])
  })

  it('refuses a length field past the end', () => {
    const b = Buffer.alloc(256)
    b.writeUInt32BE(300, 0)
    expect(() => unpad(b)).toThrow(/range/)
  })
})
