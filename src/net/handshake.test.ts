import { describe, expect, it } from 'vitest'
import { b64u, generateEd25519, generateX25519 } from './crypto.js'
import { signDirectory, verifyDirectory } from './directory.js'
import { acceptJoin, acceptOpen, buildJoin, buildOpen, channelFor, openJoinReply, sealJoinReply } from './handshake.js'
import { decodeUrlUpdate, encodeUrlUpdate } from './url-update.js'

const host = { x: generateX25519(), e: generateEd25519() }
const member = { x: generateX25519(), e: generateEd25519() }
const netId = b64u.encode(Buffer.alloc(16, 4))
const token = b64u.encode(Buffer.alloc(32, 8))
const salt = Buffer.alloc(16, 2)
const now = new Date('2026-11-19T10:00:00.000Z')
const SKEW = 5 * 60_000

describe('join handshake', () => {
  it('carries the token and handle to the host, and the reply back', () => {
    const { req, replyKey } = buildJoin({ me: member, netId, hostX: host.x.pub, token, handle: 'bob', salt })
    const accepted = acceptJoin(host.x, netId, req)
    expect(accepted.body).toMatchObject({ token, handle: 'bob' })
    expect(accepted.replyKey).toEqual(replyKey)
    const dir = signDirectory(host.e.priv, { netId, network: 'team', epoch: 1, url: 'https://x.example', urlSeq: 1, members: [] })
    expect(openJoinReply(replyKey, sealJoinReply(accepted.replyKey, { handle: 'bob', directory: dir })).handle).toBe('bob')
  })

  it('never shows the token on the wire', () => {
    const { req } = buildJoin({ me: member, netId, hostX: host.x.pub, token, salt })
    expect(JSON.stringify(req)).not.toContain(token)
  })

  it('fails for a host other than the one in the invite', () => {
    const impostor = generateX25519()
    const { req } = buildJoin({ me: member, netId, hostX: host.x.pub, token, salt })
    expect(() => acceptJoin(impostor, netId, req)).toThrow()
  })

  it('fails when the member keys are swapped in transit', () => {
    const { req } = buildJoin({ me: member, netId, hostX: host.x.pub, token, salt })
    expect(() => acceptJoin(host.x, netId, { ...req, me: b64u.encode(generateEd25519().pub) })).toThrow()
  })

  it('does not let an impostor host answer the member', () => {
    const { replyKey } = buildJoin({ me: member, netId, hostX: host.x.pub, token, salt })
    const wrongKey = Buffer.alloc(32, 1)
    const dir = signDirectory(host.e.priv, { netId, network: 'team', epoch: 1, url: 'u', urlSeq: 1, members: [] })
    expect(() => openJoinReply(replyKey, sealJoinReply(wrongKey, { handle: 'bob', directory: dir }))).toThrow()
  })
})

describe('open handshake', () => {
  const csid = b64u.encode(Buffer.alloc(16, 3))
  const hsid = b64u.encode(Buffer.alloc(16, 5))

  it('gives both sides a working channel', () => {
    const req = buildOpen({ me: member.x, netId, hostX: host.x.pub, csid: b64u.decode(csid), now })
    const ss = acceptOpen(host.x, netId, req, now, SKEW)
    const hostSide = channelFor(ss, csid, hsid, 'bob', 'host')
    const memberSide = channelFor(Buffer.from(ss), csid, hsid, 'bob', 'member')
    expect(hostSide.open('/v1/rpc', memberSide.seal('/v1/rpc', Buffer.from('hi'))).toString()).toBe('hi')
  })

  it('refuses a request replayed after the skew window', () => {
    const req = buildOpen({ me: member.x, netId, hostX: host.x.pub, csid: b64u.decode(csid), now })
    expect(() => acceptOpen(host.x, netId, req, new Date(now.getTime() + SKEW + 1000), SKEW)).toThrow(/too old/)
  })

  it('refuses someone without the member key', () => {
    const req = buildOpen({ me: member.x, netId, hostX: host.x.pub, csid: b64u.decode(csid), now })
    expect(() => acceptOpen(host.x, netId, { ...req, mx: b64u.encode(generateX25519().pub) }, now, SKEW)).toThrow()
  })
})

describe('directory signature', () => {
  const unsigned = { netId, network: 'team', epoch: 3, url: 'https://x.example', urlSeq: 2, members: [] }

  it('verifies with the host key and fails for any change', () => {
    const d = signDirectory(host.e.priv, unsigned)
    expect(verifyDirectory(host.e.pub, d)).toBe(true)
    expect(verifyDirectory(host.e.pub, { ...d, url: 'https://evil.example' })).toBe(false)
    expect(verifyDirectory(generateEd25519().pub, d)).toBe(false)
  })
})

describe('signed address updates', () => {
  const check = { hostEPub: host.e.pub, netId, lastSeq: 1 }
  const update = { netId, url: 'https://new.example', seq: 2, ts: now.toISOString() }

  it('accepts an update from the pinned host with a higher seq', () => {
    expect(decodeUrlUpdate(encodeUrlUpdate(host.e.priv, update), check)).toEqual({ ok: true, update })
  })

  it('refuses an update signed by anyone else', () => {
    const r = decodeUrlUpdate(encodeUrlUpdate(generateEd25519().priv, update), check)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not signed by your network's host/) })
  })

  it('refuses a replayed older update', () => {
    expect(decodeUrlUpdate(encodeUrlUpdate(host.e.priv, update), { ...check, lastSeq: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/older/) })
  })

  it('refuses another network, a plain URL, and plain http off loopback', () => {
    expect(decodeUrlUpdate(encodeUrlUpdate(host.e.priv, update), { ...check, netId: 'other' }).ok).toBe(false)
    expect(decodeUrlUpdate('https://evil.example', check)).toMatchObject({ ok: false, error: expect.stringMatching(/Not a signed address update/) })
    expect(decodeUrlUpdate(encodeUrlUpdate(host.e.priv, { ...update, url: 'http://evil.example' }), check).ok).toBe(false)
  })
})
