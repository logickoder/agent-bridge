import type { Transport } from './link.js'
import type { Relay } from './relay.js'
import type { RpcOp, RpcReply } from './schema.js'
import type { PollWaits } from './waits.js'

/**
 * The host's own member, talking to its relay in the same process. No outer channel: nothing leaves the
 * machine. The inner envelopes are the same as any member's, so the host's own agents get no shortcut.
 */
export class LocalTransport implements Transport {
  constructor(
    private readonly relay: Relay,
    private readonly waits: PollWaits,
  ) {}

  call(op: RpcOp): Promise<RpcReply> {
    const r = this.relay.localOp(op)
    if ('reply' in r) return Promise.resolve(r.reply)
    const wait = r.wait
    return this.waits.hold(this.relay.handle, wait.waitMs, () => this.relay.pollNow(this.relay.handle, wait))
  }

  setUrl(): void {
    // The host is the relay: it never moves away from itself.
  }
}
