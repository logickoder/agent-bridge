import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { onLines, writeLine } from '../src/lib/wire.js'

/**
 * Helpers for tests that run the built CLI in one or more bridge homes. Each home is its own user and machine
 * as far as the bridge can tell: its own daemon, socket, keys and network state.
 */

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const CLI = path.join(REPO, 'dist', 'cli.js')

// Strip the real agent sessions a test may run inside, so nothing ever pushes into a live Claude or agy session.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && !k.startsWith('ANTIGRAVITY_')))

export interface Proc {
  p: ChildProcessWithoutNullStreams
  out: () => string
  exited: () => Promise<number | null>
}

/** Runs argv on a pseudo-terminal and exits with its code. Node has no pty of its own. */
const PTY = 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Polls until `check` passes. Fixed sleeps flake when process startup is slow. */
export async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      if (check()) return
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`)
    await sleep(50)
  }
}

export interface Home {
  dir: string
  /** The environment every command here runs with: this home, and no real agent session. */
  env: Record<string, string>
  run: (args: string[], extra?: Record<string, string>, input?: string) => string
  /** Like run, but returns the error text instead of throwing. */
  fail: (args: string[], extra?: Record<string, string>, input?: string) => string
  /** Runs the CLI on a pseudo-terminal, typing `input`: for prompts that refuse a pipe. Returns all it printed. */
  tty: (args: string[], input: string) => string
  start: (args: string[], extra?: Record<string, string>) => Proc
  /** Stops every process started here, then the daemon, and deletes the home. */
  dispose: () => Promise<void>
}

/** A fresh bridge home. Unix socket paths cap near 104 bytes, so the path stays short. */
export function home(tag: string): Home {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${tag}-`))
  const env = { ...inherited, AGENT_BRIDGE_HOME: dir }
  const procs: ChildProcessWithoutNullStreams[] = []
  const run = (args: string[], extra: Record<string, string> = {}, input?: string): string =>
    execFileSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) })
  const fail = (args: string[], extra: Record<string, string> = {}, input?: string): string => {
    try {
      run(args, extra, input)
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err)
      return stderr
    }
    throw new Error(`expected \`${args.join(' ')}\` to fail`)
  }
  const tty = (args: string[], input: string): string =>
    execFileSync('python3', ['-c', PTY, process.execPath, CLI, ...args], { env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
  const start = (args: string[], extra: Record<string, string> = {}): Proc => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra } })
    procs.push(p)
    let out = ''
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    const exit = new Promise<number | null>(r => p.on('exit', r))
    return { p, out: () => out, exited: () => (p.exitCode !== null ? Promise.resolve(p.exitCode) : exit) }
  }
  const dispose = async (): Promise<void> => {
    // Listeners respawn a missing daemon, so they go first.
    await Promise.all(
      procs.map(p => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise<void>(r => {
        p.once('exit', () => r())
        p.kill()
      }))),
    )
    try {
      run(['restart'])
    } catch {
      // already down
    }
    // A host's port keeper outlives the daemon on purpose. Tests stop it with the home.
    try {
      const keeper: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'net', 'keeper.json'), 'utf8'))
      const pid = typeof keeper === 'object' && keeper !== null ? Reflect.get(keeper, 'pid') : undefined
      if (typeof pid === 'number') process.kill(pid)
    } catch {
      // no keeper, or already gone
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { dir, env, run, fail, tty, start, dispose }
}

/** Every file under `dir`, as one string, for checks that something never reached the disk. */
export function readTree(dir: string): string {
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n')
}

/**
 * How `secret` could appear inside base64 or base64url text, at each of the three byte alignments. The chars that
 * also depend on neighbouring bytes are cut from both ends, so what is left must appear if the secret is there.
 */
export function base64Forms(secret: string): string[] {
  const forms: string[] = []
  for (const pad of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(pad), Buffer.from(secret)]).toString('base64').replace(/=+$/, '')
    const core = b64.slice(pad === 0 ? 0 : 4, b64.length - 4)
    if (core.length < 8) continue
    forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return forms
}

/** One request over a home's daemon socket, with no CLI in between. Resolves with the first reply line as JSON text. */
export function socketRequest(h: Home, req: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(h.dir, 'bridge.sock'))
    s.on('error', reject)
    onLines(
      s,
      v => {
        s.end()
        resolve(JSON.stringify(v))
      },
      line => reject(new Error(line)),
    )
    writeLine(s, req)
  })
}
