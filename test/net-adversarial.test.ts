import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { b64u, generateEd25519, generateX25519, sign } from '../src/net/crypto.js'
import { buildOpen, memberBinding } from '../src/net/handshake.js'
import { HostState, Identity } from '../src/net/schema.js'
import { encodeUrlUpdate } from '../src/net/url-update.js'
import { MAX_REMOTE_TEXT } from '../src/schema.js'
import { home, socketRequest, until, type Home, type Proc } from './harness.js'
import { startProxy, type Proxy } from './proxy.js'

// The network under attack and failure: a tunnel that tampers, hosts and guests that go away, an address that
// moves, a member that is removed or comes back with new keys, and a host that swaps in its own key.

const A_AGENT = 'ocelot-coder'
const B_AGENT = 'zebra-planner'
const H_AGENT = 'heron-reviewer'

let p1: Proxy
let p2: Proxy
const homes: Home[] = []
let H: Home
let A: Home
let B: Home

interface Agent {
  name: string
  env: Record<string, string>
  monitor: Proc
}

interface Status {
  remote?: { address: string; online: boolean; keyVerified: boolean; blocked: boolean }[]
  network?: { outbox: number; connected: boolean }
}
const status = (h: Home): Status => JSON.parse(h.run(['status'])) as Status
const sees = (h: Home, address: string, timeoutMs?: number): Promise<void> =>
  until(() => (status(h).remote ?? []).some(r => r.address === address && r.online && !r.blocked), `${address} visible`, timeoutMs)

function agent(h: Home, name: string): Agent {
  const env = { CLAUDE_CODE_SESSION_ID: `sess-${name}-${path.basename(h.dir)}` }
  h.run(['join', '--kind', 'claude', '--no-push', name], env)
  const monitor = h.start(['monitor'], env)
  h.run(['net', 'share'], env)
  return { name, env, monitor }
}

/** Stops the monitor, then the daemon, so nothing on `h` restarts it. */
async function takeDown(h: Home, a: Agent): Promise<void> {
  a.monitor.p.kill()
  await a.monitor.exited()
  h.run(['restart'])
}

const count = (text: string, needle: string): number => text.split(needle).length - 1
const fingerprintOf = (h: Home): string => /Your fingerprint: ([A-Z2-7-]+)/.exec(h.run(['net', 'fingerprint']))?.[1] ?? ''
const firstLine = (s: string): string => s.split('\n')[0] ?? ''

/** One send over the daemon socket, without a CLI process, so a burst really is a burst. */
const socketSend = (h: Home, from: Agent, to: string, text: string): Promise<string> =>
  socketRequest(h, { op: 'send', from: from.name, to, text, sessions: [from.env['CLAUDE_CODE_SESSION_ID'] ?? ''] })

const hostLog = (): string => fs.readFileSync(path.join(H.dir, 'daemon.log'), 'utf8')

beforeAll(async () => {
  p1 = await startProxy()
  p2 = await startProxy()
  H = home('h')
  A = home('a')
  B = home('b')
  homes.push(H, A, B)
})

afterAll(async () => {
  await Promise.all(homes.map(h => h.dispose()))
  await Promise.all([p1.close(), p2.close()])
}, 60_000)

describe('network under attack and failure', { timeout: 60_000 }, () => {
  let a: Agent
  let b: Agent
  let h: Agent
  /** Bob on a new machine, with new keys. */
  let A2: Home | undefined

  it('sets up a host and two members', async () => {
    const out = H.run(['net', 'host', '--public-url', `http://127.0.0.1:${p1.port}`, '--port', '0', '--name', 'team', '--handle', 'alice'])
    await p1.setTarget(Number(/127\.0\.0\.1:(\d+)/.exec(out)?.[1]))
    A.run(['net', 'connect', firstLine(H.run(['net', 'invite'])), '--handle', 'bob'])
    B.run(['net', 'connect', firstLine(H.run(['net', 'invite'])), '--handle', 'carol'])
    a = agent(A, A_AGENT)
    b = agent(B, B_AGENT)
    h = agent(H, H_AGENT)
    await sees(A, `${B_AGENT}@carol`)
    await sees(B, `${A_AGENT}@bob`)
  })

  it('rejects a frame tampered on the way to the host, then delivers the message once', async () => {
    const tampered = p1.tamper('up')
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'TAMPER-UP-1'], a.env)
    await tampered
    await until(() => b.monitor.out().includes('TAMPER-UP-1'), 'delivered after tamper', 30_000)
    expect(hostLog()).toMatch(/rpc: rejected a frame from (bob|carol)/)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'AFTER-UP'], a.env)
    await until(() => b.monitor.out().includes('AFTER-UP'), 'next message')
    expect(count(b.monitor.out(), 'TAMPER-UP-1')).toBe(1)
  })

  it('rejects a frame tampered on the way back, then delivers the message once', async () => {
    const tampered = p1.tamper('down')
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'TAMPER-DOWN-1'], a.env)
    await tampered
    await until(() => b.monitor.out().includes('TAMPER-DOWN-1'), 'delivered after tamper', 30_000)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'AFTER-DOWN'], a.env)
    await until(() => b.monitor.out().includes('AFTER-DOWN'), 'next message', 30_000)
    expect(count(b.monitor.out(), 'TAMPER-DOWN-1')).toBe(1)
  })

  it('keeps a message in the outbox while the host is down, and delivers it once after', async () => {
    await takeDown(H, h)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'WHILE-HOST-DOWN'], a.env)
    await until(() => (status(A).network?.outbox ?? 0) >= 1 || b.monitor.out().includes('WHILE-HOST-DOWN'), 'queued in the outbox')
    expect(b.monitor.out()).not.toContain('WHILE-HOST-DOWN')
    // Waiting mail is private, like every other file under net/.
    const outbox = path.join(A.dir, 'net', 'outbox', `${B_AGENT}@carol.json`)
    expect(fs.statSync(outbox).mode & 0o777).toBe(0o600)
    h = agent(H, H_AGENT)
    await until(() => b.monitor.out().includes('WHILE-HOST-DOWN'), 'delivered after host restart', 45_000)
    expect(count(b.monitor.out(), 'WHILE-HOST-DOWN')).toBe(1)
  })

  it('holds mail for an offline member at the host until it returns', async () => {
    await sees(A, `${B_AGENT}@carol`)
    await takeDown(B, b)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'WHILE-CAROL-OFF'], a.env)
    await until(() => {
      const box = path.join(H.dir, 'net', 'mailbox', 'carol.json')
      return fs.existsSync(box) && (JSON.parse(fs.readFileSync(box, 'utf8')) as { entries: { t: string }[] }).entries.some(e => e.t === 'msg')
    }, 'sealed in carol\'s mailbox at the host', 30_000)
    b = agent(B, B_AGENT)
    await until(() => b.monitor.out().includes('WHILE-CAROL-OFF'), 'delivered when carol returns', 30_000)
  })

  it('refuses a message over the size limit', () => {
    expect(A.fail(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'x'.repeat(MAX_REMOTE_TEXT + 1)], a.env)).toMatch(/limited to 65536/)
  })

  it('delivers a burst past the host\'s rate limit, all of it, in order', async () => {
    await sees(A, `${B_AGENT}@carol`)
    const n = 60
    const sent = await Promise.all(Array.from({ length: n }, (_, i) => socketSend(A, a, `${B_AGENT}@carol`, `BURST-${String(i).padStart(3, '0')}`)))
    for (const r of sent) expect(r).toMatch(/"type":"sent"/)
    await until(() => count(b.monitor.out(), 'BURST-') === n, `all ${n} burst messages`, 45_000)
    const order = [...b.monitor.out().matchAll(/BURST-(\d{3})/g)].map(m => Number(m[1]))
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(hostLog()).toMatch(/rate limited bob/)
  })

  it('moves to a new address: a connected member follows, an offline one applies the signed line', async () => {
    // Before any move there is nothing for an offline member to apply, so status offers no line.
    expect(H.run(['net', 'status'])).not.toMatch(/net set-url/)
    await takeDown(B, b)
    const local = /Local port: (\d+)/.exec(H.run(['net', 'status']))?.[1]
    await p2.setTarget(Number(local))
    const moved = H.run(['net', 'set-url', `http://127.0.0.1:${p2.port}`])
    const line = /agent-bridge net set-url (\S+)/.exec(moved)?.[1] ?? ''
    expect(line).toMatch(/^agent-bridge-url:1:/)
    await until(() => A.run(['net', 'status']).includes(`Host: http://127.0.0.1:${p2.port}`), 'bob follows', 45_000)
    await p1.close()

    // A forged update, signed by a key that is not the host's, is refused.
    const fake = encodeUrlUpdate(generateEd25519().priv, { netId: 'x'.repeat(22), url: 'https://evil.example', seq: 99, ts: new Date().toISOString() })
    expect(B.fail(['net', 'set-url', fake])).toMatch(/not signed by your network's host/)
    expect(B.run(['net', 'set-url', line])).toMatch(/signed by your host/)
    // The same line again is a replay: refused.
    expect(B.fail(['net', 'set-url', line])).toMatch(/older than the one in use/)
    expect(H.run(['net', 'status'])).toContain('agent-bridge net set-url agent-bridge-url:1:')

    b = agent(B, B_AGENT)
    await sees(A, `${B_AGENT}@carol`, 45_000)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'AT-NEW-ADDRESS'], a.env)
    await until(() => b.monitor.out().includes('AT-NEW-ADDRESS'), 'delivered at the new address', 30_000)
  })

  it('removes a kicked member: it is told, others drop it, and its key cannot open a session', async () => {
    H.run(['net', 'kick', 'carol'])
    await until(() => /removed this daemon/.test(B.run(['net', 'status'])), 'carol told', 45_000)
    await until(() => !/carol/.test(A.run(['net', 'status'])), 'bob drops carol', 30_000)
    expect(A.fail(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'x'], a.env)).toMatch(/No member "carol"/)

    const id = Identity.parse(JSON.parse(fs.readFileSync(path.join(B.dir, 'net', 'identity.json'), 'utf8')))
    const host = HostState.parse(JSON.parse(fs.readFileSync(path.join(H.dir, 'net', 'host.json'), 'utf8')))
    const hx = JSON.parse(fs.readFileSync(path.join(H.dir, 'net', 'identity.json'), 'utf8')) as { x: { pub: string } }
    const open = buildOpen({ me: { pub: b64u.decode(id.x.pub), priv: b64u.decode(id.x.priv) }, netId: host.netId, hostX: b64u.decode(hx.x.pub), csid: Buffer.alloc(16, 7), now: new Date() })
    const res = await fetch(`http://127.0.0.1:${p2.port}/v1/open`, { method: 'POST', body: JSON.stringify(open) })
    expect(res.status).toBe(403)
  })

  it('blocks a member that comes back with new keys until the user trusts it, and keeps it unverified', async () => {
    A2 = home('a2')
    homes.push(A2)
    const invite = firstLine(H.run(['net', 'invite', '--handle', 'bob']))
    expect(A2.run(['net', 'connect', invite])).toMatch(/as bob/)
    await until(() => /bob +KEY CHANGED/.test(H.run(['net', 'status'])), 'host sees the key change', 30_000)
    expect(H.fail(['send', '--as', H_AGENT, `${A_AGENT}@bob`, 'x'], h.env)).toMatch(/bob's key changed/)
    // Accepting a changed key is the user's call: never from an agent session, and only on a terminal.
    expect(H.fail(['net', 'trust', 'bob'], h.env)).toMatch(/An agent session cannot accept bob's changed key/)
    expect(H.fail(['net', 'verify', 'bob', 'AAAA'], h.env)).toMatch(/An agent session cannot accept bob's changed key/)
    expect(await socketRequest(H, { op: 'net', cmd: { cmd: 'trust', handle: 'bob' }, sessions: ['s'] })).toMatch(/cannot accept bob's changed key/)
    expect(H.fail(['net', 'trust', 'bob'])).toMatch(/Trusting a key needs your terminal/)
    expect(H.tty(['net', 'trust', 'bob'], 'trust bob\n')).toMatch(/It is not verified/)
    const a2 = agent(A2, A_AGENT)
    await sees(H, `${A_AGENT}@bob`, 30_000)
    H.run(['send', '--as', H_AGENT, `${A_AGENT}@bob`, 'TO-NEW-BOB'], h.env)
    await until(() => a2.monitor.out().includes('TO-NEW-BOB'), 'delivered to the new key', 30_000)
    expect(H.run(['net', 'status'])).toMatch(/bob +online +unverified/)
    // The old machine was replaced, so the host removed it.
    await until(() => /removed this daemon/.test(A.run(['net', 'status'])), 'old bob removed', 45_000)
  })

  it('catches a host that swaps in its own key for a member: the real fingerprint does not verify', async () => {
    if (!A2) throw new Error('needs the key-change test first')
    const realBob = fingerprintOf(A2)
    const invite = firstLine(H.run(['net', 'invite']))
    // Play a dishonest host: stop it, put keys it made in place of bob's, start it again.
    await takeDown(H, h)
    const file = path.join(H.dir, 'net', 'host.json')
    const state = HostState.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    const fx = generateX25519()
    const fe = generateEd25519()
    state.members = state.members.map(m =>
      m.handle === 'bob' ? { ...m, x: b64u.encode(fx.pub), e: b64u.encode(fe.pub), sig: b64u.encode(sign(fe.priv, memberBinding(state.netId, fx.pub))) } : m,
    )
    fs.writeFileSync(file, JSON.stringify(state))
    h = agent(H, H_AGENT)

    const M = home('m')
    homes.push(M)
    expect(M.run(['net', 'connect', invite, '--handle', 'dave'])).toMatch(/as dave/)
    expect(M.run(['net', 'status'])).toMatch(/bob +(online|offline) +unverified/)
    expect(M.fail(['net', 'verify', 'bob', realBob])).toMatch(/possibly the host, may be intercepting/)
    expect(M.run(['net', 'status'])).toMatch(/bob +(online|offline) +unverified/)
  })
})
