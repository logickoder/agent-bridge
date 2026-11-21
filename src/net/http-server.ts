import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { toError } from '../lib/errors.js'
import { TokenBucket } from '../lib/rate.js'
import type { Relay } from './relay.js'
import { OpenReq, RpcWire, type FrameT } from './schema.js'
import type { PollWaits } from './waits.js'

/**
 * The host's HTTP face, on 127.0.0.1 only: the tunnel forwards to it. Four routes, all JSON. Every auth
 * failure gets the same 404, so a prober cannot tell a wrong token from a wrong path. Nothing secret is
 * logged: bodies are sealed, and tokens never leave the join handler.
 */

const LIMITS = { '/v1/join': 8 * 1024, '/v1/open': 4 * 1024, '/v1/rpc': 256 * 1024 } as const
type Route = keyof typeof LIMITS
/**
 * Allowances for requests made before the caller proves anything. Behind a tunnel every caller looks like
 * 127.0.0.1, so they cannot be told apart by address. A reconnect names a member key, which strangers never
 * see, so each known key gets its own allowance: junk from strangers cannot keep members out.
 */
const STRANGER = { burst: 30, perSecond: 5 }
const JOIN = { burst: 10, perSecond: 1 }
const MEMBER_OPEN = { burst: 10, perSecond: 1 }
const TICK_MS = 10_000

export interface NetServerDeps {
  relay: Relay
  waits: PollWaits
  log: (msg: string) => void
  now?: () => number
}

/** Where the server listens: a 127.0.0.1 port (0 picks one), or a socket file only this user can reach. */
export type Listen = { port: number } | { socket: string }

export interface NetServer {
  /** The bound port, for a port listen. */
  port: number | undefined
  close(): Promise<void>
}

class TooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Answer 413 first; the handler closes the socket once the answer is out.
        req.removeAllListeners('data')
        req.resume()
        reject(new TooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', reject)
  })
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

const notFound = (res: http.ServerResponse): void => reply(res, 404, { error: 'not found' })

const isRoute = (p: string): p is Route => p in LIMITS

/** Starts the server. A port listen with port 0 picks a free one; the result says which. */
export function startNetServer(deps: NetServerDeps, listen: Listen): Promise<NetServer> {
  const now = deps.now ?? Date.now
  const bucket = (c: { burst: number; perSecond: number }): TokenBucket => new TokenBucket(c.burst, c.perSecond, now())
  const strangers = bucket(STRANGER)
  const joins = bucket(JOIN)
  const members = new Map<string, TokenBucket>()

  /** The allowance a pre-auth request spends from. Undefined: rpc, which is already sealed to a session. */
  function allowance(path: Route, body: unknown): TokenBucket | undefined {
    if (path === '/v1/rpc') return undefined
    if (path === '/v1/join') return joins
    const mx = OpenReq.pick({ mx: true }).safeParse(body)
    if (!mx.success || !deps.relay.knowsKey(mx.data.mx)) return strangers
    let b = members.get(mx.data.mx)
    if (!b) members.set(mx.data.mx, (b = bucket(MEMBER_OPEN)))
    return b
  }

  async function rpc(body: unknown, res: http.ServerResponse, closed: () => boolean): Promise<void> {
    const wire = RpcWire.safeParse(body)
    if (!wire.success) return reply(res, 400, { error: 'bad request' })
    const r = deps.relay.rpc(wire.data.sid, wire.data.frame)
    switch (r.type) {
      case 'unauthorized':
        return reply(res, 401, { error: 'open a session' })
      case 'bad':
        return reply(res, 400, { error: 'bad request' })
      case 'reply':
        return reply(res, 200, r.frame)
      case 'wait': {
        await deps.waits.hold(r.handle, r.op.waitMs, () => deps.relay.pollNow(r.handle, r.op))
        // Gone while held: answering would seal mail it never reads. Its cursor did not move, so it gets it again.
        if (closed()) return
        const frame: FrameT | undefined = deps.relay.answer(wire.data.sid, r.op)
        return frame ? reply(res, 200, frame) : reply(res, 401, { error: 'open a session' })
      }
    }
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/v1/health') return reply(res, 200, { ok: true, v: 1 })
    if (req.method !== 'POST' || !isRoute(url.pathname)) return notFound(res)
    const path = url.pathname
    let closed = false
    res.on('close', () => {
      closed = true
    })
    let body: unknown
    try {
      body = await readBody(req, LIMITS[path])
    } catch (err) {
      if (err instanceof TooLarge) {
        res.once('finish', () => req.socket.destroy())
        res.setHeader('connection', 'close')
        return reply(res, 413, { error: 'too large' })
      }
      throw err
    }
    const limit = allowance(path, body)
    if (limit && !limit.take(now())) return reply(res, 429, { error: 'slow down', retryAfterMs: limit.waitMs(now()) })
    switch (path) {
      case '/v1/join': {
        const r = deps.relay.join(body)
        if (r.ok) return reply(res, 200, { c: r.c })
        return r.revoked ? reply(res, 403, { error: 'revoked' }) : notFound(res)
      }
      case '/v1/open': {
        const r = deps.relay.open(body)
        if (r.type === 'ok') return reply(res, 200, { hsid: r.hsid })
        // Only a caller that proved it holds a removed member's key learns it was removed.
        return r.type === 'revoked' ? reply(res, 403, { error: 'revoked' }) : notFound(res)
      }
      case '/v1/rpc':
        return rpc(body, res, () => closed)
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      deps.log(`http: ${toError(err).message}`)
      reply(res, 500, { error: 'internal' })
    })
  })
  // Polls hold for up to 25s. Keep idle sockets a little longer than a tunnel would.
  server.keepAliveTimeout = 30_000
  const tick = setInterval(() => deps.relay.tick(), TICK_MS)
  tick.unref()

  return new Promise((resolve, reject) => {
    server.once('error', err => {
      clearInterval(tick)
      reject(err)
    })
    const ready = (): void => {
      const addr: AddressInfo | string | null = server.address()
      if ('socket' in listen) fs.chmodSync(listen.socket, 0o600)
      resolve({
        port: addr !== null && typeof addr === 'object' ? addr.port : undefined,
        close: () =>
          new Promise<void>(done => {
            clearInterval(tick)
            deps.waits.releaseAll()
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    }
    if ('port' in listen) return void server.listen(listen.port, '127.0.0.1', ready)
    // A crashed daemon leaves its socket file behind.
    fs.rmSync(listen.socket, { force: true })
    server.listen(listen.socket, ready)
  })
}
