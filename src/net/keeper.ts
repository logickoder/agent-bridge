import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { errnoCode, toError } from '../lib/errors.js'
import { isAlive } from '../daemon/lock.js'
import { readOrSetAside, writeJson } from '../lib/json-file.js'
import { logger } from '../lib/log.js'
import { CLI, DAEMON_LOCK, NET_DIR, NET_HTTP_SOCK, NET_KEEPER, NET_KEEPER_LOG } from '../paths.js'
import { KeeperState } from './schema.js'

/**
 * The keeper: a small process, detached from the daemon, that holds the local port a tunnel forwards to and
 * relays each connection to the daemon's socket file (private to this user). A tunnel must never forward to a
 * port that another program could take, and the daemon comes and goes (restarts, installs, crashes), so the
 * port belongs to the keeper instead. With the daemon down, the keeper answers 503 and members retry.
 *
 * For `--public-url` the keeper holds the port until `net stop`. With `--tunnel cloudflared` it also runs a free
 * Cloudflare quick tunnel as its child, for trying networks only: Cloudflare calls quick tunnels testing-only, with
 * no uptime guarantee, and the address changes every time cloudflared restarts. A daemon restart adopts the
 * running keeper, so the address survives `agent-bridge install`. Once the daemon has been gone for GRACE_MS the
 * keeper stops the quick tunnel and itself, and frees the port only after cloudflared has exited.
 */

const BIN = process.env['AGENT_BRIDGE_CLOUDFLARED'] ?? 'cloudflared'
/** How long a trial tunnel outlives the daemon: enough for a restart or install to bring the daemon back. */
const GRACE_MS = Number(process.env['AGENT_BRIDGE_TUNNEL_GRACE_MS'] ?? 60_000)
const DAEMON_CHECK_MS = 2000
const START_TIMEOUT_MS = 30_000
const STOP_WAIT_MS = 3000
const POLL_MS = 200
const HEALTH_TIMEOUT_MS = 5000
const log = logger('net')

/** Lines the keeper writes to its log for `launch` to read. */
const NOT_FOUND = 'agent-bridge: cloudflared not found'
const PORT_LINE = /agent-bridge: keeper holds port (\d+)/
const PORT_BUSY = /agent-bridge: port (\d+) is in use/
const REGISTERED = /Registered tunnel connection/
/** A quick tunnel host. `api.` is cloudflared's own endpoint, which shows up in its error lines. */
const QUICK = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![\w.-])/
const OFFLINE =
  'HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: 25\r\nconnection: close\r\n\r\n{"error":"host offline"}\n'
const NOT_INSTALLED = 'cloudflared is not installed. Install it (`brew install cloudflared`), or run your own tunnel and pass --public-url.'

/** The quick tunnel's address from cloudflared's output, if it printed one yet. */
export function parseQuickTunnelUrl(output: string): string | undefined {
  return QUICK.exec(output)?.[0]
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

const readKeeper = (): KeeperState | undefined => readOrSetAside(NET_KEEPER, KeeperState, log)

/**
 * The running keeper for this mode and port, if it still relays to this daemon. Checked through the port (and
 * the tunnel), so a reused pid or a stranger on the port is never adopted.
 */
async function adopt(port: number, cloudflared: boolean): Promise<KeeperState | undefined> {
  if (port === 0) return undefined
  const saved = readKeeper()
  if (!saved || saved.port !== port || (saved.url !== undefined) !== cloudflared || !isAlive(saved.pid)) return undefined
  if (await answers(saved.url ?? `http://127.0.0.1:${port}`)) return saved
  stopKeeper()
  // A new keeper takes the same port, so the old one must have let go of it first.
  const deadline = Date.now() + STOP_WAIT_MS * 2
  while (isAlive(saved.pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, POLL_MS))
  return undefined
}

/** Why the keeper gave up, from its log, if it said. */
function keeperFailure(text: string): string | undefined {
  if (text.includes(NOT_FOUND)) return NOT_INSTALLED
  const busy = PORT_BUSY.exec(text)
  if (busy) return `Port ${busy[1] ?? ''} is in use. Another program listens there. Pick a free one with --port.`
  return undefined
}

/** Starts a keeper on `port` (0 picks a free one), and waits until it holds the port and, if asked, has a tunnel. */
async function launch(port: number, cloudflared: boolean): Promise<KeeperState> {
  fs.mkdirSync(NET_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(NET_KEEPER_LOG, '', { mode: 0o600 })
  const args = [CLI, 'keeper', String(port), ...(cloudflared ? ['--cloudflared'] : [])]
  const keeper = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env })
  keeper.unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const text = fs.readFileSync(NET_KEEPER_LOG, 'utf8')
    const failure = keeperFailure(text)
    if (failure) throw new Error(failure)
    const held = Number(PORT_LINE.exec(text)?.[1])
    // For a tunnel, wait for a registered connection too. Looking the name up before it exists gets the failure
    // cached by the system resolver, and then the tunnel looks down for a minute after it is up.
    const url = cloudflared ? parseQuickTunnelUrl(text) : undefined
    const ready = held > 0 && (!cloudflared || (url !== undefined && REGISTERED.test(text)))
    if (ready && keeper.pid !== undefined) {
      const state: KeeperState = { pid: keeper.pid, port: held, ...(url !== undefined ? { url } : {}) }
      writeJson(NET_KEEPER, state, { mode: 0o600 })
      return state
    }
    if (keeper.exitCode !== null) break
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  keeper.kill()
  // The keeper may have written why it stopped just before it exited.
  const failure = keeperFailure(fs.readFileSync(NET_KEEPER_LOG, 'utf8'))
  if (failure) throw new Error(failure)
  const what = cloudflared ? 'cloudflared gave no address' : 'The port keeper did not start'
  throw new Error(`${what} within ${START_TIMEOUT_MS / 1000}s. See ${NET_KEEPER_LOG}.${cloudflared ? ' Check your connection, or pass --public-url.' : ''}`)
}

/** The keeper for this mode: the running one on `port`, or a new one. */
export async function ensureKeeper(port: number, cloudflared: boolean): Promise<KeeperState> {
  return (await adopt(port, cloudflared)) ?? launch(port, cloudflared)
}

/** True while the keeper this daemon started is still running. */
export function keeperRunning(): boolean {
  const saved = readKeeper()
  return saved !== undefined && isAlive(saved.pid)
}

/** Waits up to `ms` for `url` to answer the health check. */
export async function waitReachable(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await answers(url)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

/**
 * True if `pid` runs `agent-bridge keeper`. A keeper that died leaves its pid in keeper.json, and the system may
 * hand that pid to an unrelated process: never signal one without checking.
 */
function isKeeper(pid: number): boolean {
  try {
    // Any install's cli.js: an upgrade may have moved the package since this keeper started.
    return /cli\.js keeper\b/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }))
  } catch {
    return false
  }
}

/** Stops the keeper (and its tunnel), if any. True if one was running. */
export function stopKeeper(): boolean {
  const saved = readKeeper()
  fs.rmSync(NET_KEEPER, { force: true })
  if (!saved || !isAlive(saved.pid) || !isKeeper(saved.pid)) return false
  try {
    process.kill(saved.pid)
    return true
  } catch (err) {
    log(`could not stop the port keeper (pid ${saved.pid}): ${toError(err).message}`)
    return false
  }
}

// --- The keeper process ---

function daemonAlive(): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(DAEMON_LOCK, 'utf8'), 10)
    return Number.isInteger(pid) && isAlive(pid)
  } catch {
    return false
  }
}

const note = (line: string): void => fs.appendFileSync(NET_KEEPER_LOG, `agent-bridge: ${line}\n`)

/** One connection from the tunnel: relayed to the daemon's socket, or told the host is offline. */
function relay(client: net.Socket): void {
  const upstream = net.connect(NET_HTTP_SOCK)
  let connected = false
  upstream.once('connect', () => {
    connected = true
    client.pipe(upstream)
    upstream.pipe(client)
  })
  upstream.on('error', () => {
    if (!connected) client.end(OFFLINE)
    else client.destroy()
  })
  client.on('error', () => upstream.destroy())
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => {
    if (connected) client.destroy()
  })
}

/**
 * `agent-bridge keeper <port> [--cloudflared]`, started by `launch`. Binds the port first. With --cloudflared it
 * then runs cloudflared as its child pointed at the port, and frees the port only after cloudflared has exited:
 * when told to stop, when cloudflared exits on its own, or when the daemon has been gone for GRACE_MS. Without
 * it, the keeper holds the port until told to stop.
 */
export function runKeeper(args: string[]): void {
  const wanted = Number(args[0])
  const cloudflared = args.includes('--cloudflared')
  const server = net.createServer(relay)
  let child: ReturnType<typeof spawn> | undefined
  let stopping = false
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    const done = (): never => {
      server.close()
      process.exit(code)
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return done()
    child.once('exit', done)
    child.kill()
    setTimeout(() => {
      child?.kill('SIGKILL')
      done()
    }, STOP_WAIT_MS).unref()
  }
  server.once('error', err => {
    note(errnoCode(err) === 'EADDRINUSE' ? `port ${wanted} is in use` : err.message)
    process.exit(1)
  })
  server.listen(wanted, '127.0.0.1', () => {
    const addr = server.address()
    const port = addr !== null && typeof addr === 'object' ? addr.port : wanted
    note(`keeper holds port ${port}`)
    if (!cloudflared) return
    const out = fs.openSync(NET_KEEPER_LOG, 'a', 0o600)
    child = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', out, out] })
    fs.closeSync(out)
    child.once('error', err => {
      note(errnoCode(err) === 'ENOENT' ? 'cloudflared not found' : err.message)
      stop(1)
    })
    child.once('exit', c => stop(c ?? 1))
  })
  process.on('SIGTERM', () => stop(0))
  process.on('SIGINT', () => stop(0))
  if (!cloudflared) return
  let seen = Date.now()
  setInterval(() => {
    if (daemonAlive()) seen = Date.now()
    else if (Date.now() - seen > GRACE_MS) {
      note(`the daemon has been gone for ${Math.round(GRACE_MS / 1000)}s. Stopping the tunnel.`)
      stop(0)
    }
  }, DAEMON_CHECK_MS)
}
