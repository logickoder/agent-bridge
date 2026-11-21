import type { RpcReply } from './schema.js'

/**
 * Held polls. A poll with nothing new waits here until the relay wakes its member or the hold runs out.
 * Shared by the HTTP server and the host's in-process transport. Timers are injected.
 */

export type Timer = (ms: number, fn: () => void) => () => void

interface Held {
  check: () => RpcReply | undefined
  done: (r: RpcReply) => void
  cancel: () => void
}

export class PollWaits {
  private readonly held = new Map<string, Set<Held>>()

  constructor(private readonly timer: Timer) {}

  /** Waits up to `ms` for `check` to have something. Resolves with an empty reply on timeout. */
  hold(handle: string, ms: number, check: () => RpcReply | undefined): Promise<RpcReply> {
    return new Promise(resolve => {
      const set = this.held.get(handle) ?? new Set<Held>()
      this.held.set(handle, set)
      const h: Held = {
        check,
        done: r => {
          h.cancel()
          set.delete(h)
          resolve(r)
        },
        cancel: () => {},
      }
      h.cancel = this.timer(ms, () => h.done(check() ?? { ok: true, mail: [] }))
      set.add(h)
    })
  }

  /** Something changed for `handle`: answer its held polls that now have something. */
  wake(handle: string): void {
    for (const h of [...(this.held.get(handle) ?? [])]) {
      const r = h.check()
      if (r) h.done(r)
    }
  }

  /** Ends every hold with an empty reply, e.g. on shutdown. */
  releaseAll(): void {
    for (const set of this.held.values()) for (const h of [...set]) h.done({ ok: true, mail: [] })
  }
}
