import { describe, expect, it } from 'vitest'
import { Channel, REPLAY_WINDOW, ReplayWindow, type Frame } from './channel.js'
import { b64u } from './crypto.js'

const init = { ss: Buffer.alloc(32, 7), csid: Buffer.alloc(16, 1), hsid: Buffer.alloc(16, 2), handle: 'bob' }
const pair = (): { member: Channel; host: Channel } => ({
  member: new Channel({ ...init, role: 'member' }),
  host: new Channel({ ...init, role: 'host' }),
})
const text = Buffer.from('hello host')

function flip(f: Frame): Frame {
  const b = b64u.decode(f.c)
  b[0] = (b[0] ?? 0) ^ 1
  return { n: f.n, c: b64u.encode(b) }
}

describe('Channel', () => {
  it('round-trips in both directions and agrees on the session id', () => {
    const { member, host } = pair()
    expect(member.sid).toBe(host.sid)
    expect(host.open('/v1/rpc', member.seal('/v1/rpc', text))).toEqual(text)
    expect(member.open('/v1/rpc', host.seal('/v1/rpc', text))).toEqual(text)
  })

  it('throws on a flipped byte and still accepts the genuine frame after', () => {
    const { member, host } = pair()
    const f = member.seal('/v1/rpc', text)
    expect(() => host.open('/v1/rpc', flip(f))).toThrow()
    expect(host.open('/v1/rpc', f)).toEqual(text)
  })

  it('rejects a replayed frame', () => {
    const { member, host } = pair()
    const f = member.seal('/v1/rpc', text)
    host.open('/v1/rpc', f)
    expect(() => host.open('/v1/rpc', f)).toThrow(/replayed/)
  })

  it('accepts frames out of order', () => {
    const { member, host } = pair()
    const a = member.seal('/v1/rpc', Buffer.from('a'))
    const b = member.seal('/v1/rpc', Buffer.from('b'))
    expect(host.open('/v1/rpc', b).toString()).toBe('b')
    expect(host.open('/v1/rpc', a).toString()).toBe('a')
  })

  it('does not open a frame on another path', () => {
    const { member, host } = pair()
    expect(() => host.open('/v1/poll', member.seal('/v1/rpc', text))).toThrow()
  })

  it('does not open its own frames: direction is bound', () => {
    const { member } = pair()
    expect(() => member.open('/v1/rpc', member.seal('/v1/rpc', text))).toThrow()
  })

  it('gives different sessions different keys', () => {
    const a = new Channel({ ...init, role: 'member' })
    const b = new Channel({ ...init, hsid: Buffer.alloc(16, 3), role: 'host' })
    expect(a.sid).not.toBe(b.sid)
    expect(() => b.open('/v1/rpc', a.seal('/v1/rpc', text))).toThrow()
  })

  it('binds the handle', () => {
    const a = new Channel({ ...init, role: 'member' })
    const b = new Channel({ ...init, handle: 'eve', role: 'host' })
    expect(() => b.open('/v1/rpc', a.seal('/v1/rpc', text))).toThrow()
  })
})

describe('ReplayWindow', () => {
  it('refuses counters below the window and non-positive ones', () => {
    const w = new ReplayWindow()
    w.mark(REPLAY_WINDOW + 10)
    expect(w.fresh(10)).toBe(false)
    expect(w.fresh(11)).toBe(true)
    expect(w.fresh(0)).toBe(false)
    expect(w.fresh(-1)).toBe(false)
    expect(w.fresh(1.5)).toBe(false)
  })
})
