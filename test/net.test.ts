import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { base64Forms, home, readTree, socketRequest, until, type Home, type Proc } from './harness.js'
import { startProxy, type Proxy } from './proxy.js'

// Three users on three machines, played by three bridge homes on this one. H hosts, A and B join through a
// recording proxy that stands in for the tunnel. Real daemons, real HTTP, built CLI.

const MARKER = 'PAPAYA-SECRET-42'
const REPLY = 'MANGO-REPLY-7'
const A_AGENT = 'ocelot-coder'
const B_AGENT = 'zebra-planner'
const H_AGENT = 'heron-reviewer'

let proxy: Proxy
let H: Home
let A: Home
let B: Home
const homes: Home[] = []

interface Remote {
  address: string
  online: boolean
  keyVerified: boolean
}
const remote = (h: Home): Remote[] => (JSON.parse(h.run(['status'])) as { remote?: Remote[] }).remote ?? []
const sees = (h: Home, address: string): Promise<void> => until(() => remote(h).some(r => r.address === address && r.online), `${address} visible`)

/** A Claude session on `h` holding `name`, shared, with a monitor printing what arrives. */
function agent(h: Home, name: string): { env: Record<string, string>; monitor: Proc } {
  const env = { CLAUDE_CODE_SESSION_ID: `sess-${name}` }
  h.run(['join', '--kind', 'claude', '--no-push', name], env)
  const monitor = h.start(['monitor'], env)
  h.run(['net', 'share'], env)
  return { env, monitor }
}

const fingerprintOf = (h: Home): string => /Your fingerprint: ([A-Z2-7-]+)/.exec(h.run(['net', 'fingerprint']))?.[1]?.trim() ?? ''

beforeAll(async () => {
  proxy = await startProxy()
  H = home('h')
  A = home('a')
  B = home('b')
  homes.push(H, A, B)
})

afterAll(async () => {
  await Promise.all(homes.map(h => h.dispose()))
  await proxy.close()
})

describe('network across three homes', { timeout: 40_000 }, () => {
  let a: ReturnType<typeof agent>
  let b: ReturnType<typeof agent>
  let hAgent: ReturnType<typeof agent>

  it('hosts a network behind the tunnel', async () => {
    const out = H.run(['net', 'host', '--public-url', `http://127.0.0.1:${proxy.port}`, '--port', '0', '--name', 'team', '--handle', 'alice'])
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1])
    expect(port).toBeGreaterThan(0)
    await proxy.setTarget(port)
    expect(out).toMatch(/Hosting network "team" as alice/)
  })

  it('refuses a plain-http public address that is not loopback', () => {
    expect(A.fail(['net', 'host', '--public-url', 'http://example.com', '--port', '0'])).toMatch(/must be https/)
  })

  it('joins two members with single-use invites read from stdin', () => {
    const invite = H.run(['net', 'invite']).split('\n')[0] ?? ''
    expect(invite).toMatch(/^agent-bridge-invite:1:/)
    expect(A.run(['net', 'connect', '-', '--handle', 'bob'], {}, invite)).toMatch(/Joined network "team" as bob\. Members: alice/)
    expect(B.fail(['net', 'connect', '-', '--handle', 'carol'], {}, invite)).toMatch(/refused the invite/)
    const second = H.run(['net', 'invite']).split('\n')[0] ?? ''
    expect(B.run(['net', 'connect', second, '--handle', 'carol'])).toMatch(/as carol\. Members: alice, bob/)
  })

  it('lists every member in each home, unverified until checked', async () => {
    await until(() => /carol .*unverified/.test(A.run(['net', 'status'])), 'bob sees carol')
    const status = H.run(['net', 'status'])
    expect(status).toMatch(/hosted here as alice/)
    expect(status).toMatch(/bob +(online|offline) +unverified/)
    expect(status).toMatch(/Compare fingerprints/)
  })

  it('carries a message from one guest to another and the reply back', async () => {
    a = agent(A, A_AGENT)
    b = agent(B, B_AGENT)
    await sees(A, `${B_AGENT}@carol`)
    const sent = A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, MARKER], a.env)
    expect(sent).toMatch(/network/i)
    await until(() => b.monitor.out().includes(MARKER), 'message at carol')
    expect(b.monitor.out()).toMatch(/another user's agent/)
    expect(b.monitor.out()).toContain(`${A_AGENT}@bob`)

    await sees(B, `${A_AGENT}@bob`)
    B.run(['send', '--as', B_AGENT, `${A_AGENT}@bob`, REPLY], b.env)
    await until(() => a.monitor.out().includes(REPLY), 'reply at bob')
  })

  it('carries messages to and from the host\'s own agent', async () => {
    hAgent = agent(H, H_AGENT)
    await sees(A, `${H_AGENT}@alice`)
    A.run(['send', '--as', A_AGENT, `${H_AGENT}@alice`, 'to the host'], a.env)
    await until(() => hAgent.monitor.out().includes('to the host'), 'message at alice')
    await sees(H, `${A_AGENT}@bob`)
    H.run(['send', '--as', H_AGENT, `${A_AGENT}@bob`, 'from the host'], hAgent.env)
    await until(() => a.monitor.out().includes('from the host'), 'message from alice')
  })

  it('never shows the tunnel a body, an agent name or an invite token', () => {
    const wire = proxy.recorded().toString('latin1')
    expect(wire.length).toBeGreaterThan(0)
    for (const secret of [MARKER, REPLY, A_AGENT, B_AGENT, H_AGENT]) {
      expect(wire).not.toContain(secret)
      for (const form of base64Forms(secret)) expect(wire).not.toContain(form)
    }
  })

  it('never writes a guest\'s body or agent names into the relay\'s files', () => {
    // The host's own member keeps its own outbox and records, like any member. The relay's files are the claim.
    const files = [readTree(path.join(H.dir, 'net', 'mailbox')), fs.readFileSync(path.join(H.dir, 'net', 'host.json'), 'utf8')].join('\n')
    expect(files.length).toBeGreaterThan(0)
    for (const secret of [MARKER, REPLY, A_AGENT, B_AGENT]) expect(files).not.toContain(secret)
  })

  it('refuses a wrong fingerprint and accepts the right one', async () => {
    expect(A.fail(['net', 'verify', 'carol', 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA'])).toMatch(/may be intercepting/)
    expect(A.run(['net', 'verify', 'carol', fingerprintOf(B).toLowerCase()])).toMatch(/carol's key is verified/)
    expect(A.run(['net', 'status'])).toMatch(/carol +(online|offline) +verified/)
    await until(() => remote(A).some(r => r.address === `${B_AGENT}@carol` && r.keyVerified), 'verified in status')
  })

  it('lets only a shell outside any agent session raise a member\'s level', async () => {
    expect(A.fail(['net', 'allow', 'carol', 'chat'], { CLAUDE_CODE_SESSION_ID: 'sess-1' })).toMatch(/An agent session cannot raise a member's level/)
    expect(A.fail(['net', 'allow', 'carol', 'chat'])).toMatch(/Raising a level needs your terminal/)
    expect(() => A.tty(['net', 'allow', 'carol', 'chat'], 'carol work\n')).toThrow()
    expect(A.run(['net', 'status'])).toMatch(/carol +(online|offline) +verified +allow: ask/)
    expect(A.tty(['net', 'allow', 'carol', 'chat', '--for', '2'], 'carol chat\n')).toMatch(/carol's agents may answer from what they already know/)
    expect(A.run(['net', 'status'])).toMatch(/carol +(online|offline) +verified +allow: chat until /)
    expect(A.tty(['net', 'allow', 'carol', 'work', '--agents', A_AGENT], 'carol work\n')).toMatch(new RegExp(`covers ${A_AGENT} only`))
    expect(A.run(['net', 'status'])).toMatch(new RegExp(`carol +(online|offline) +verified +allow: work \\(${A_AGENT} only\\)`))
    expect(A.run(['net', 'share'], a.env)).toContain(`Levels for ${A_AGENT}: carol: work. Every other member is at ask.`)
    // A client that skips the CLI still names its sessions, and the daemon refuses the raise as well.
    expect(await socketRequest(A, { op: 'net', cmd: { cmd: 'allow', handle: 'carol', level: 'work' }, sessions: ['sess-1'] })).toMatch(/An agent session cannot raise/)
    expect(A.run(['net', 'allow', 'carol', 'ask'], { CLAUDE_CODE_SESSION_ID: 'sess-1' })).toMatch(/carol's agents must check with you/)
    expect(A.run(['net', 'status'])).toMatch(/carol +(online|offline) +verified +allow: ask/)
  })

  it('keeps the network across a guest daemon restart', async () => {
    A.run(['restart'])
    await sees(A, `${B_AGENT}@carol`)
    A.run(['send', '--as', A_AGENT, `${B_AGENT}@carol`, 'after restart'], a.env)
    await until(() => b.monitor.out().includes('after restart'), 'message after restart')
  })

  it('keeps the network across a host daemon restart', async () => {
    H.run(['restart'])
    // The new daemon starts on the next client call and listens on the saved port.
    await until(() => /Local port: \d+/.test(H.run(['net', 'status'])), 'host back')
    await sees(B, `${A_AGENT}@bob`)
    B.run(['send', '--as', B_AGENT, `${A_AGENT}@bob`, 'after host restart'], b.env)
    await until(() => a.monitor.out().includes('after host restart'), 'message after host restart', 20_000)
  })

  it('removes a kicked member everywhere', async () => {
    expect(H.run(['net', 'kick', 'carol'])).toMatch(/Removed carol/)
    await until(() => !/carol/.test(A.run(['net', 'status'])), 'carol gone at bob', 15_000)
    await until(() => /removed this daemon/.test(B.run(['net', 'status'])), 'carol told', 30_000)
    expect(B.run(['net', 'leave'])).toMatch(/Left network/)
    expect(B.run(['net', 'status'])).toMatch(/Not in a network/)
  })

  it('lets a member leave, and the host see it go', async () => {
    expect(A.run(['net', 'leave'])).toMatch(/Left network "team"/)
    await until(() => !/bob/.test(H.run(['net', 'status'])), 'bob gone at host', 15_000)
    expect(A.fail(['send', '--as', A_AGENT, `${H_AGENT}@alice`, 'x'], a.env)).toMatch(/No network/)
  })

  it('lets a member that left rejoin with a plain invite, under its old handle', () => {
    const invite = H.run(['net', 'invite']).split('\n')[0] ?? ''
    expect(A.run(['net', 'connect', invite, '--handle', 'someone-else'])).toMatch(/as bob\./)
  })

  it('tells a kicked machine why a plain invite does not work', () => {
    const invite = H.run(['net', 'invite']).split('\n')[0] ?? ''
    expect(B.fail(['net', 'connect', invite, '--handle', 'carol'])).toMatch(/removed this machine.*--handle/)
  })

  it('stops the network only with --yes', () => {
    expect(H.fail(['net', 'stop'])).toMatch(/--yes/)
    expect(H.run(['net', 'stop', '--yes'])).toMatch(/Stopped network "team"/)
    expect(H.run(['net', 'status'])).toMatch(/Not in a network/)
  })
})
