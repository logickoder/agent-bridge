import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { isDaemonDown, toError } from '../lib/errors.js'
import { CLI, DAEMON_LOG, ensureHome, SOCK } from '../paths.js'
import type { Identity } from '../names.js'
import { Reply, type Message, type PeerKind, type Request, type ReplyOf } from '../schema.js'
import { onLines, writeLine } from '../lib/wire.js'

const RETRY_MS = 50
const RESUBSCRIBE_MS = 500
const MAX_RESUBSCRIBE_MS = 5000
// A spawn can lose the lock to a daemon that is still shutting down. Try again at this interval.
const RESPAWN_MS = 500

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK)
    s.once('connect', () => {
      s.removeListener('error', reject)
      resolve(s)
    })
    s.once('error', reject)
  })
}

function spawnDaemon(): void {
  ensureHome()
  const out = fs.openSync(DAEMON_LOG, 'a')
  try {
    spawn(process.execPath, [CLI, 'daemon'], { detached: true, stdio: ['ignore', out, out] }).unref()
  } finally {
    // The child has its own copy. Long-lived clients respawn often and would leak one per try.
    fs.closeSync(out)
  }
}

export interface ConnectOptions {
  spawnDaemon?: boolean
  timeoutMs?: number
}

/** Connects to the daemon, starting it if nobody is listening. */
export async function connect({ spawnDaemon: mayspawn = true, timeoutMs = 3000 }: ConnectOptions = {}): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs
  let lastSpawn = 0
  for (;;) {
    try {
      return await connectOnce()
    } catch (err) {
      if (!isDaemonDown(err) || !mayspawn) throw err
      if (Date.now() - lastSpawn >= RESPAWN_MS) {
        lastSpawn = Date.now()
        spawnDaemon()
      }
      if (Date.now() > deadline) {
        throw new Error(`daemon not reachable at ${SOCK}. It did not start within ${timeoutMs}ms. See ${DAEMON_LOG}.`)
      }
      await new Promise(r => setTimeout(r, RETRY_MS))
    }
  }
}

const isReply = <T extends Reply['type']>(reply: Reply, type: T): reply is ReplyOf<T> => reply.type === type

function parseReply(value: unknown): Reply {
  const parsed = Reply.safeParse(value)
  if (!parsed.success) throw new Error(`daemon sent an invalid reply: ${parsed.error.message}. Restart it with \`agent-bridge restart\`.`)
  return parsed.data
}

/** Asks a running daemon to exit. A daemon that is not running is already stopped. */
export async function stopDaemon(): Promise<void> {
  try {
    await request({ op: 'shutdown' }, 'ok', { spawnDaemon: false })
  } catch (err) {
    if (!isDaemonDown(err)) throw err
  }
}

/**
 * Binds the session's name in the daemon and returns it: the chosen name (renaming the session's current
 * one if it has one), or the auto name. Without a session, a chosen name is returned unbound.
 */
export async function resolveName(identity: Identity, kind: PeerKind, session: string | undefined, opts: { take?: boolean } = {}): Promise<string> {
  if (!session) {
    if ('name' in identity) return identity.name
    throw new Error('no session id. An auto name needs one. Run this from inside the agent, or pass a name.')
  }
  const target = 'name' in identity ? { name: identity.name, ...(opts.take ? { take: true } : {}) } : { folder: identity.folder }
  return (await request({ op: 'claim', ...target, kind, session }, 'claimed')).name
}

/** One request, one reply. Rejects on an `error` reply. */
export async function request<T extends Reply['type']>(req: Request, expect: T, opts?: ConnectOptions): Promise<ReplyOf<T>> {
  const s = await connect(opts)
  return new Promise((resolve, reject) => {
    let settled = false
    s.on('error', reject)
    onLines(
      s,
      value => {
        settled = true
        s.end()
        try {
          const reply = parseReply(value)
          if (reply.type === 'error') return reject(new Error(reply.message))
          if (!isReply(reply, expect)) return reject(new Error(`daemon replied "${reply.type}", expected "${expect}".`))
          resolve(reply)
        } catch (err) {
          reject(err)
        }
      },
      line => reject(new Error(`daemon sent an unparseable line: ${line.slice(0, 200)}`)),
    )
    s.on('close', () => {
      if (!settled) reject(new Error('daemon closed the connection without a reply.'))
    })
    writeLine(s, req)
  })
}

export interface Listener {
  /** Handle one non-message reply. Return true to stop listening. */
  onControl(reply: Exclude<Reply, { type: 'msg' }>): boolean
  /** Resolve once the message is safely delivered; the daemon then drops it. */
  onMessage(msg: Message): Promise<void>
  /** A protocol or delivery failure. Connection drops are not errors: holdListen retries them. */
  onError(err: Error): void
  /** The connection dropped or could not be made. Informational; a retry is already scheduled. */
  onDisconnect?(err: Error): void
}

/**
 * Holds a listen connection open until onControl says stop. A failed connect or a dropped
 * socket schedules a retry with backoff, so a daemon restart or a slow start never ends it.
 */
export function holdListen(
  req: Extract<Request, { op: 'listen' }>,
  listener: Listener,
  connectFn: () => Promise<Duplex> = () => connect({ timeoutMs: 5000 }),
): void {
  let stopped = false
  let delay = RESUBSCRIBE_MS
  const retry = (err?: Error): void => {
    if (stopped) return
    if (err) listener.onDisconnect?.(err)
    setTimeout(() => void arm(), delay)
    delay = Math.min(delay * 2, MAX_RESUBSCRIBE_MS)
  }
  const arm = async (): Promise<void> => {
    let s: Duplex
    try {
      s = await connectFn()
    } catch (err) {
      return retry(toError(err))
    }
    delay = RESUBSCRIBE_MS
    let dropped: Error | undefined
    // 'close' always follows 'error'. Retry once, from close.
    s.on('error', err => {
      dropped = err
    })
    s.on('close', () => retry(dropped))
    onLines(
      s,
      value => {
        let reply: Reply
        try {
          reply = parseReply(value)
        } catch (err) {
          return listener.onError(toError(err))
        }
        if (reply.type !== 'msg') {
          if (listener.onControl(reply)) stopped = true
          return
        }
        listener.onMessage(reply.msg).then(
          () => {
            // A one-shot listener is done after its message; the daemon closes the socket.
            if (!req.stream) stopped = true
            // `to`, not req.as: a listener by session has no `as`, and its name can change by rename.
            writeLine(s, { op: 'ack', as: reply.msg.to, id: reply.msg.id })
          },
          (err: unknown) => {
            listener.onError(toError(err))
            s.destroy()
          },
        )
      },
      line => listener.onError(new Error(`daemon sent an unparseable line: ${line.slice(0, 200)}`)),
    )
    writeLine(s, req)
  }
  void arm()
}
