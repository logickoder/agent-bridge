import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../schema.js'
import { hookOutput, type Drained } from './hook.js'

const msg = (id: string): Message => ({ id, from: 'claude', to: 'agy', text: `text ${id}`, ts: '2026-11-02T00:00:00.000Z' })
const drained = (msgs: Message[]): Drained => ({ msgs, ack: vi.fn(async () => {}) })

describe('hookOutput', () => {
  it('returns {} without a conversationId, without asking the daemon', async () => {
    const drain = vi.fn()
    expect((await hookOutput('{}', drain)).out).toEqual({})
    expect((await hookOutput('not json', drain)).out).toEqual({})
    expect(drain).not.toHaveBeenCalled()
  })

  it('drains for the calling conversation and injects the messages', async () => {
    const d = drained([msg('m1')])
    const drain = vi.fn(async () => d)
    const r = await hookOutput('{"conversationId":"c1","invocationNum":3}', drain)
    expect(drain).toHaveBeenCalledWith('c1')
    expect(r.out).toEqual({ injectSteps: [{ userMessage: expect.stringContaining('text m1') }] })
    expect(r.ack).toBe(d.ack)
  })

  it('does not ack before the caller has printed', async () => {
    const d = drained([msg('m1')])
    await hookOutput('{"conversationId":"c1"}', async () => d)
    expect(d.ack).not.toHaveBeenCalled()
  })

  it('returns {} and nothing to ack when nothing is queued', async () => {
    const r = await hookOutput('{"conversationId":"c1"}', async () => drained([]))
    expect(r).toEqual({ out: {} })
  })

  it('fails open when the daemon errors', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await hookOutput('{"conversationId":"c1"}', async () => Promise.reject(new Error('down')))).toEqual({ out: {} })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('drain failed'))
    stderr.mockRestore()
  })
})
