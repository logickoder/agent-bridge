import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { onLines } from '../src/lib/wire.js'

// End-to-end: real daemon, real sockets, built CLI. Unix socket paths cap near 104 bytes, so keep HOME short.
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(REPO, 'dist', 'cli.js')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
const env = { ...process.env, AGENT_BRIDGE_HOME: HOME }
const procs: ChildProcessWithoutNullStreams[] = []

interface Proc {
  p: ChildProcessWithoutNullStreams
  out: () => string
  exited: () => Promise<number | null>
}

const run = (args: string[], extra: Record<string, string> = {}, input?: string): string =>
  execFileSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8', ...(input === undefined ? {} : { input }) })

function start(args: string[], extra: Record<string, string> = {}): Proc {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra } })
  procs.push(p)
  let out = ''
  p.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  const exit = new Promise<number | null>(r => p.on('exit', r))
  return { p, out: () => out, exited: () => (p.exitCode !== null ? Promise.resolve(p.exitCode) : exit) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface StatusPeer {
  name: string
  kind: string
  session: string | null
  online: boolean
  queued: number
}
const status = (): { pid: number; peers: StatusPeer[] } => JSON.parse(run(['status'])) as { pid: number; peers: StatusPeer[] }
const peer = (name: string): StatusPeer | undefined => status().peers.find(p => p.name === name)
/** Polls until `check` passes. Fixed sleeps flake when process startup is slow. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (check()) return
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const online = (name: string, session?: string) =>
  until(() => {
    const p = peer(name)
    return !!p?.online && (session === undefined || p.session === session)
  }, `${name} online`)
const killDaemon = async () => {
  run(['restart'])
  await sleep(200)
}

interface Rpc {
  p: ChildProcessWithoutNullStreams
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>
  notify: (method: string) => void
  notes: Record<string, unknown>[]
}

function mcp(kind: 'claude' | 'agy', extra: Record<string, string> = {}): Rpc {
  const p = spawn(process.execPath, [CLI, 'mcp', kind], { env: { ...env, ...extra } })
  procs.push(p)
  let next = 1
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  const notes: Record<string, unknown>[] = []
  onLines(
    p.stdout,
    value => {
      const m = value as Record<string, unknown>
      const resolve = typeof m['id'] === 'number' ? pending.get(m['id']) : undefined
      if (resolve) resolve(m)
      else notes.push(m)
    },
    line => {
      throw new Error(`mcp server printed a non-JSON line: ${line}`)
    },
  )
  return {
    p,
    notes,
    call: (method, params = {}) =>
      new Promise(r => {
        const id = next++
        pending.set(id, r)
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
    notify: method => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
  }
}

const init = async (rpc: Rpc) => {
  await rpc.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e' } })
  rpc.notify('notifications/initialized')
}
const toolText = (r: Record<string, unknown>): string => JSON.stringify(r['result'])
const channelTexts = (rpc: Rpc): unknown[] =>
  rpc.notes.filter(n => n['method'] === 'notifications/claude/channel').map(n => (n['params'] as { content: unknown }).content)

afterAll(async () => {
  for (const p of procs) p.kill()
  try {
    run(['restart'])
  } catch {
    // daemon already gone
  }
  await sleep(100)
  fs.rmSync(HOME, { recursive: true, force: true })
})

describe('agy listener', () => {
  it('rejects sends to a peer that never joined', () => {
    expect(() => run(['send', 'agy', 'hi'])).toThrow()
  })

  it('wakes on a live message and prints reply and re-arm hints', async () => {
    const l = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    await online('agy', 'conv-1')
    expect(l.p.exitCode).toBeNull()
    expect(peer('agy')).toMatchObject({ kind: 'agy', session: 'conv-1', online: true })
    expect(run(['send', 'agy', 'MANGO-7'])).toMatch(/Delivered live/)
    expect(await l.exited()).toBe(0)
    expect(l.out()).toMatch(/MANGO-7[\s\S]*to "shell", as "agy"[\s\S]*agent-bridge listen --as agy/)
  })

  it('queues while offline and delivers on the next listen', async () => {
    expect(run(['send', 'agy', 'later'])).toMatch(/Queued for agy/)
    const l = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    expect(await l.exited()).toBe(0)
    expect(l.out()).toMatch(/later/)
  })

  it('keeps the message when the listener is killed', async () => {
    const l = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    await online('agy', 'conv-1')
    l.p.kill('SIGKILL')
    await l.exited()
    await until(() => peer('agy')?.online === false, 'agy offline')
    run(['send', 'agy', 'survives'])
    const l2 = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    expect(await l2.exited()).toBe(0)
    expect(l2.out()).toMatch(/survives/)
  })

  it('reconnects across a daemon restart', async () => {
    const l = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    await online('agy', 'conv-1')
    await killDaemon()
    await online('agy', 'conv-1')
    expect(l.p.exitCode).toBeNull()
    run(['send', 'agy', 'after restart'])
    expect(await l.exited()).toBe(0)
    expect(l.out()).toMatch(/after restart/)
  })

  it('a newer session takes over the name and the old listener stops', async () => {
    const a = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' })
    await online('agy', 'conv-1')
    const b = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-2' })
    expect(await a.exited()).toBe(0)
    expect(a.out()).toMatch(/took over[\s\S]*Do not re-arm/)
    run(['send', 'agy', 'for conv-2'])
    expect(await b.exited()).toBe(0)
    expect(b.out()).toMatch(/for conv-2/)
  })

  it('leave stops listeners and releases the binding', async () => {
    const l = start(['listen', '--as', 'agy'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-2' })
    await online('agy', 'conv-2')
    run(['leave', 'agy'])
    expect(await l.exited()).toBe(0)
    expect(l.out()).toMatch(/left the bridge/)
    expect(peer('agy')).toMatchObject({ session: null, online: false })
  })
})

describe('auto names', () => {
  // run() executes in the repo folder, so the base is agent-bridge-<kind>.
  it('gives each new agy session the next free name and keeps it per session', () => {
    expect(run(['join'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-1' })).toMatch(/Joined agent-bridge as "agent-bridge-agy"/)
    expect(run(['join'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-2' })).toMatch(/as "agent-bridge-agy-2"/)
    expect(run(['join'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-1' })).toMatch(/as "agent-bridge-agy"/)
  })

  it('tells a session its name', () => {
    expect(run(['whoami'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-2' }).trim()).toBe('agent-bridge-agy-2')
  })

  it('requires a name for listen', () => {
    expect(() => run(['listen'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-1' })).toThrow(/listen needs --as/)
  })

  it('names a Claude session from its folder and says so in the instructions', async () => {
    const c = mcp('claude', { AGENT_BRIDGE_FOLDER: '/p/agent-bridge', CLAUDE_CODE_SESSION_ID: 'claude-auto-1' })
    const r = await c.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e' } })
    expect(JSON.stringify(r['result'])).toContain('You are peer \\"agent-bridge-claude\\"')
    expect(peer('agent-bridge-claude')).toMatchObject({ kind: 'claude', session: 'claude-auto-1' })
    c.p.kill()
  })

  it('keeps the Claude server up, send-only, when the name cannot be claimed', async () => {
    const blocker = path.join(HOME, 'not-a-dir')
    fs.writeFileSync(blocker, '')
    const c = mcp('claude', { AGENT_BRIDGE_FOLDER: '/p/x', CLAUDE_CODE_SESSION_ID: 'c-fail', AGENT_BRIDGE_HOME: path.join(blocker, 'home') })
    const r = await c.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e' } })
    expect(JSON.stringify(r['result'])).toMatch(/could not get a peer name/)
    c.p.kill()
  }, 15000)

  it('names who is listening when the recipient is not', async () => {
    const l = start(['listen', '--as', 'agent-bridge-agy-2'], { ANTIGRAVITY_CONVERSATION_ID: 'auto-2' })
    await online('agent-bridge-agy-2')
    expect(run(['send', 'agent-bridge-agy', 'hi'])).toMatch(/Listening now: .*agent-bridge-agy-2/)
    run(['send', 'agent-bridge-agy-2', 'done'])
    await l.exited()
  })
})

describe('agy hook', () => {
  it('injects only for the bound conversation', async () => {
    const l = start(['listen', '--as', 'agy-b'], { ANTIGRAVITY_CONVERSATION_ID: 'conv-b' })
    await online('agy-b', 'conv-b')
    l.p.kill()
    await l.exited()
    await until(() => peer('agy-b')?.online === false, 'agy-b offline')
    run(['send', 'agy-b', 'hooked'])
    expect(JSON.parse(run(['agy-hook'], {}, '{"conversationId":"someone-else"}'))).toEqual({})
    expect(JSON.parse(run(['agy-hook'], {}, '{}'))).toEqual({})
    const out = JSON.parse(run(['agy-hook'], {}, '{"conversationId":"conv-b"}')) as { injectSteps: { userMessage: string }[] }
    expect(out.injectSteps[0]?.userMessage).toMatch(/hooked/)
    expect(peer('agy-b')?.queued).toBe(0)
  })

  it('returns {} fast when the daemon is down', () => {
    const t = Date.now()
    const out = run(['agy-hook'], { AGENT_BRIDGE_HOME: path.join(HOME, 'nowhere') }, '{"conversationId":"x"}')
    expect(JSON.parse(out)).toEqual({})
    expect(Date.now() - t).toBeLessThan(1500)
  })
})

describe('mcp servers', () => {
  it('Claude server pushes channel messages and sends as its peer name', async () => {
    const lead = mcp('claude', { AGENT_BRIDGE_PEER: 'lead' })
    await init(lead)
    await online('lead')
    expect(peer('lead')).toMatchObject({ kind: 'claude', online: true })

    const agy = mcp('agy')
    await init(agy)
    expect((await agy.call('server/discover'))['error']).toMatchObject({ code: -32601 })
    const sent = await agy.call('tools/call', { name: 'send', arguments: { to: 'lead', text: 'hi lead', as: 'agy-b' } })
    expect(toolText(sent)).toMatch(/Delivered live to lead/)
    await until(() => channelTexts(lead).length > 0, 'channel push')
    expect(channelTexts(lead)).toEqual(['hi lead'])

    const reply = await lead.call('tools/call', { name: 'send', arguments: { to: 'agy-b', text: 'hi back' } })
    expect(toolText(reply)).toMatch(/Queued for agy-b/)
    const out = JSON.parse(run(['agy-hook'], {}, '{"conversationId":"conv-b"}')) as { injectSteps: { userMessage: string }[] }
    expect(out.injectSteps[0]?.userMessage).toMatch(/Message from lead to agy-b[\s\S]*hi back/)

    const listed = await agy.call('tools/call', { name: 'peers', arguments: {} })
    expect(toolText(listed)).toMatch(/lead \(claude\) listening/)
    lead.p.kill()
    agy.p.kill()
  })

  it('agy server requires `as`', async () => {
    const agy = mcp('agy')
    await init(agy)
    const r = await agy.call('tools/call', { name: 'send', arguments: { to: 'lead', text: 'x' } })
    expect(r['result']).toMatchObject({ isError: true })
    agy.p.kill()
  })

  it('a server without AGENT_BRIDGE_PEER never consumes', async () => {
    run(['send', 'lead', 'keep me'])
    const plain = mcp('claude')
    await init(plain)
    await sleep(300)
    expect(channelTexts(plain)).toEqual([])
    expect(peer('lead')?.queued).toBe(1)
    plain.p.kill()
    const lead = mcp('claude', { AGENT_BRIDGE_PEER: 'lead' })
    await init(lead)
    await until(() => channelTexts(lead).length > 0, 'queued channel push')
    expect(channelTexts(lead)).toEqual(['keep me'])
    lead.p.kill()
  })
})

describe('cli send', () => {
  it('takes --as only before the recipient and keeps the rest as text', async () => {
    const l = start(['listen', '--as', 'cli-t'])
    await online('cli-t')
    run(['send', 'cli-t', 'run', 'it', '--as', 'admin'])
    await until(() => l.out().includes('run it --as admin'), 'message text')
    expect(l.out()).toContain('from shell to cli-t')
    const m = start(['listen', '--as', 'cli-t'])
    await online('cli-t')
    run(['send', '--as', 'me', 'cli-t', 'hello'])
    await until(() => m.out().includes('hello'), 'second message')
    expect(m.out()).toContain('from me to cli-t')
  })

  it('rejects a sender name nobody could reply to', () => {
    expect(() => run(['send', '--as', 'Bob Smith', 'cli-t', 'hi'])).toThrow(/--as "Bob Smith" is invalid/)
  })
})

describe('daemon', () => {
  it('answers an invalid request with a readable error', async () => {
    run(['status'])
    const sock = net.createConnection(path.join(HOME, 'bridge.sock'))
    sock.write('{"op":"nope"}\n')
    const line = await new Promise<string>(resolve => sock.once('data', d => resolve(d.toString())))
    sock.destroy()
    const reply = JSON.parse(line) as { type: string; message: string }
    expect(reply.type).toBe('error')
    expect(reply.message).not.toContain('[{')
    expect(reply.message).toMatch(/agent-bridge restart/)
  })

  it('runs one instance when several start at once', async () => {
    await killDaemon()
    const starts = [1, 2, 3].map(() => start(['daemon']))
    await until(() => starts.filter(d => d.p.exitCode === null).length === 1, 'two daemons to exit', 10000)
    const live = starts.filter(d => d.p.exitCode === null)
    expect(live).toHaveLength(1)
    expect(status().pid).toBe(live[0]?.p.pid)
  })
})

describe('install', () => {
  it('adds and removes only agent-bridge entries, idempotently', () => {
    const agyDir = path.join(HOME, 'agy')
    const binDir = path.join(HOME, 'bin')
    fs.mkdirSync(agyDir)
    const council = { command: '/x/council', args: ['mcp'] }
    fs.writeFileSync(path.join(agyDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { council } }))
    fs.writeFileSync(path.join(agyDir, 'hooks.json'), JSON.stringify({ other: { PreInvocation: [] } }))
    const targets = { AGY_CONFIG_DIR: agyDir, AGENT_BRIDGE_BIN_DIR: binDir }
    run(['install'], targets)
    run(['install'], targets)

    const read = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(agyDir, f), 'utf8'))
    expect(read('mcp_config.json')).toEqual({
      mcpServers: { council, 'agent-bridge': { command: path.join(binDir, 'agent-bridge'), args: ['mcp', 'agy'], disabled: false } },
    })
    expect(read('hooks.json')).toMatchObject({ other: {}, 'agent-bridge': { enabled: true } })
    expect(fs.existsSync(path.join(agyDir, 'skills', 'bridge', 'SKILL.md'))).toBe(true)
    expect(fs.readlinkSync(path.join(binDir, 'agent-bridge'))).toBe(CLI)
    expect(fs.readlinkSync(path.join(binDir, 'claude-bridge'))).toBe(path.join(REPO, 'bin', 'claude-bridge'))

    run(['uninstall'], targets)
    expect(read('mcp_config.json')).toEqual({ mcpServers: { council } })
    expect(read('hooks.json')).toEqual({ other: { PreInvocation: [] } })
    expect(fs.existsSync(path.join(agyDir, 'skills', 'bridge'))).toBe(false)
    expect(fs.existsSync(path.join(binDir, 'agent-bridge'))).toBe(false)
  })
})
