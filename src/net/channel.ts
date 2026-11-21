import { b64u, concat, hkdf, NONCE_BYTES, open, seal } from './crypto.js'

/**
 * The outer channel between a member and the host. Keys come from the static-static X25519 secret mixed with
 * random ids from both sides (`csid` from the member, `hsid` from the host), so every session has fresh keys
 * and a counter nonce never repeats under one key, even after a restart.
 */

export type Role = 'member' | 'host'
const DIR = { m2h: 1, h2m: 2 } as const
/** How far behind the newest counter a frame may arrive. Concurrent requests finish out of order. */
export const REPLAY_WINDOW = 1024

export interface Frame {
  n: number
  c: string
}

/** Tracks which counters arrived, so each opens at most once. */
export class ReplayWindow {
  private top = 0
  private readonly seen = new Set<number>()

  /** True if `n` is new and inside the window. Does not record it. */
  fresh(n: number): boolean {
    if (!Number.isSafeInteger(n) || n < 1) return false
    if (n + REPLAY_WINDOW <= this.top) return false
    return !this.seen.has(n)
  }

  /** Records `n`. Call only after the frame authenticated. */
  mark(n: number): void {
    this.seen.add(n)
    if (n <= this.top) return
    this.top = n
    for (const s of this.seen) if (s + REPLAY_WINDOW <= this.top) this.seen.delete(s)
  }
}

function nonce(dir: number, n: number): Buffer {
  const b = Buffer.alloc(NONCE_BYTES)
  b.writeUInt32BE(dir, 0)
  b.writeBigUInt64BE(BigInt(n), 4)
  return b
}

const aadFor = (sid: string, path: string, n: number): Buffer => concat('ab/v1/frame', sid, path, String(n))

export interface ChannelInit {
  /** X25519 between the member's and the host's static keys. */
  ss: Uint8Array
  csid: Uint8Array
  hsid: Uint8Array
  /** The member's handle, bound into the keys. */
  handle: string
  role: Role
}

/** One session's keys and counters. Not thread safe, and does not need to be: Node runs it on one thread. */
export class Channel {
  readonly sid: string
  private readonly sendKey: Buffer
  private readonly recvKey: Buffer
  private readonly sendDir: number
  private readonly recvDir: number
  private counter = 0
  private readonly window = new ReplayWindow()

  constructor(init: ChannelInit) {
    const salt = Buffer.concat([init.csid, init.hsid])
    const m2h = hkdf(init.ss, salt, concat('ab/v1/chan/m2h', init.handle))
    const h2m = hkdf(init.ss, salt, concat('ab/v1/chan/h2m', init.handle))
    this.sid = b64u.encode(hkdf(init.ss, salt, concat('ab/v1/chan/sid', init.handle), 16))
    const member = init.role === 'member'
    this.sendKey = member ? m2h : h2m
    this.recvKey = member ? h2m : m2h
    this.sendDir = member ? DIR.m2h : DIR.h2m
    this.recvDir = member ? DIR.h2m : DIR.m2h
  }

  seal(path: string, plaintext: Uint8Array): Frame {
    const n = ++this.counter
    const c = seal(this.sendKey, nonce(this.sendDir, n), plaintext, aadFor(this.sid, path, n))
    return { n, c: b64u.encode(c) }
  }

  /** Opens a frame for `path`. Throws on tampering, a replay, or a frame from the other direction or path. */
  open(path: string, frame: Frame): Buffer {
    if (!this.window.fresh(frame.n)) throw new Error('Frame counter replayed or too old.')
    const pt = open(this.recvKey, nonce(this.recvDir, frame.n), b64u.decode(frame.c), aadFor(this.sid, path, frame.n))
    this.window.mark(frame.n)
    return pt
  }
}
