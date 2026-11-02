import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, Reply } from '../schema.js'
import { holdListen, type Listener } from './index.js'

/** In-memory socket: `reply` plays the daemon, `written` records what the client sent. */
class FakeSocket extends Duplex {
  readonly written: unknown[] = []
  override _read(): void {}
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    for (const line of chunk.toString().split('\n').filter(Boolean)) this.written.push(JSON.parse(line))
    cb()
  }
  reply(r: Reply): void {
    this.push(`${JSON.stringify(r)}\n`)
  }
}

const msg: Message = { id: 'm1', from: 'agy', to: 'lead', text: 'hi', ts: '2026-11-02T00:00:00.000Z' }
const req = { op: 'listen', as: 'lead', kind: 'claude', stream: true } as const

function listener(): Listener & { got: string[]; errors: Error[] } {
  const got: string[] = []
  const errors: Error[] = []
  return {
    got,
    errors,
    onControl: () => false,
    onMessage: async m => void got.push(m.text),
    onError: err => void errors.push(err),
  }
}

afterEach(() => vi.useRealTimers())

describe('holdListen', () => {
  it('retries when the first connect fails, and reports no error', async () => {
    vi.useFakeTimers()
    const sock = new FakeSocket()
    const connect = vi.fn<() => Promise<Duplex>>().mockRejectedValueOnce(new Error('daemon not reachable')).mockResolvedValue(sock)
    const l = listener()
    holdListen(req, l, connect)
    await vi.advanceTimersByTimeAsync(1000)
    expect(connect).toHaveBeenCalledTimes(2)
    sock.reply({ type: 'msg', msg })
    await vi.advanceTimersByTimeAsync(10)
    expect(l.got).toEqual(['hi'])
    expect(l.errors).toEqual([])
  })

  it('reconnects after a socket error instead of failing', async () => {
    vi.useFakeTimers()
    const first = new FakeSocket()
    const second = new FakeSocket()
    const connect = vi.fn<() => Promise<Duplex>>().mockResolvedValueOnce(first).mockResolvedValue(second)
    const l = listener()
    holdListen(req, l, connect)
    await vi.advanceTimersByTimeAsync(0)
    first.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(second.written).toEqual([req])
    expect(l.errors).toEqual([])
  })
})
