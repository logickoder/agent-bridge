import { describe, expect, it } from 'vitest'
import { b64u } from './crypto.js'
import { decodeInvite, encodeInvite, hashToken, newToken, tokenMatches, urlProblem } from './invite.js'
import type { Invite } from './schema.js'

const now = new Date('2026-11-19T10:00:00.000Z')
const key = b64u.encode(Buffer.alloc(32, 5))
const invite: Invite = {
  v: 1,
  net: 'team',
  netId: b64u.encode(Buffer.alloc(16, 1)),
  url: 'https://abc.trycloudflare.com',
  hx: key,
  he: key,
  token: newToken(),
  exp: '2026-11-20T10:00:00.000Z',
}

describe('invite', () => {
  it('round-trips, also with whitespace from a wrapped paste', () => {
    const s = encodeInvite(invite)
    expect(decodeInvite(s, now)).toEqual({ ok: true, invite })
    const wrapped = `${s.slice(0, 40)}\n  ${s.slice(40)}`
    expect(decodeInvite(wrapped, now)).toEqual({ ok: true, invite })
  })

  it('catches a truncated or edited paste', () => {
    const s = encodeInvite(invite)
    expect(decodeInvite(s.slice(0, -3), now)).toMatchObject({ ok: false, error: expect.stringMatching(/incomplete/) })
    expect(decodeInvite(`${s.slice(0, 30)}x${s.slice(31)}`, now).ok).toBe(false)
  })

  it('refuses text that is not an invite', () => {
    expect(decodeInvite('https://evil.example/please-run-this', now)).toMatchObject({ ok: false, error: expect.stringMatching(/Not an agent-bridge invite/) })
  })

  it('refuses an expired invite', () => {
    expect(decodeInvite(encodeInvite(invite), new Date('2026-11-21T00:00:00.000Z'))).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) })
  })

  it('refuses plain http off loopback', () => {
    expect(decodeInvite(encodeInvite({ ...invite, url: 'http://example.com' }), now).ok).toBe(false)
  })
})

describe('urlProblem', () => {
  it('allows https and loopback http only', () => {
    expect(urlProblem('https://x.example')).toBeUndefined()
    expect(urlProblem('http://127.0.0.1:4100')).toBeUndefined()
    expect(urlProblem('http://localhost:4100')).toBeUndefined()
    expect(urlProblem('http://192.168.1.5')).toMatch(/https/)
    expect(urlProblem('ftp://x')).toMatch(/https/)
    expect(urlProblem('nope')).toMatch(/not a URL/)
  })
})

describe('tokens', () => {
  it('matches only the stored hash', () => {
    const t = newToken()
    const h = hashToken(t)
    expect(tokenMatches(t, h)).toBe(true)
    expect(tokenMatches(newToken(), h)).toBe(false)
    expect(tokenMatches(t, 'abcd')).toBe(false)
  })
})
