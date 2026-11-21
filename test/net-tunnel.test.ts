import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { home, until, type Home } from './harness.js'

// `net host --tunnel cloudflared` with a stand-in cloudflared that prints a quick-tunnel address and waits.
// The real tunnel is covered by the live test in docs/live-tests.md.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cf-'))
const fake = path.join(dir, 'cloudflared')
fs.writeFileSync(
  fake,
  [
    '#!/bin/sh',
    `echo $$ >> ${JSON.stringify(path.join(dir, 'pids'))}`,
    'echo "INF |  https://grey-owl-tree-42.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0" >&2',
    'exec sleep 600',
    '',
  ].join('\n'),
  { mode: 0o755 },
)
const env = { AGENT_BRIDGE_CLOUDFLARED: fake, AGENT_BRIDGE_TUNNEL_GRACE_MS: '3000' }
/** The stand-in cloudflared processes started so far, newest last. */
const fakePids = (): number[] => fs.readFileSync(path.join(dir, 'pids'), 'utf8').trim().split('\n').map(Number)
const homes: Home[] = []

afterAll(async () => {
  await Promise.all(homes.map(h => h.dispose()))
  fs.rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('trial tunnel', { timeout: 60_000 }, () => {
  it('hosts behind it, says it is a trial everywhere, and stops it with the network', async () => {
    const T = home('t')
    homes.push(T)
    // The first command starts the daemon, which inherits the stand-in's path.
    const out = T.run(['net', 'host', '--tunnel', 'cloudflared', '--port', '0', '--handle', 'alice'], env)
    expect(out).toMatch(/Reachable at https:\/\/grey-owl-tree-42\.trycloudflare\.com, through local port \d+, which the port keeper holds/)
    expect(out).toMatch(/Trial tunnel\. Its address changes/)
    // The stand-in's address is not real, so the host waits, then says so.
    expect(out).toMatch(/The tunnel does not answer yet/)
    expect(T.run(['net', 'invite'], env)).toMatch(/Trial tunnel/)
    expect(T.run(['net', 'status'], env)).toMatch(/Address: https:\/\/grey-owl-tree-42\.trycloudflare\.com[\s\S]*Trial tunnel/)

    const saved = JSON.parse(fs.readFileSync(path.join(T.dir, 'net', 'keeper.json'), 'utf8')) as { pid: number }
    expect(alive(saved.pid)).toBe(true)
    const cloudflared = fakePids().at(-1) ?? 0
    expect(alive(cloudflared)).toBe(true)
    T.run(['net', 'stop', '--yes'], env)
    await until(() => !alive(saved.pid) && !alive(cloudflared), 'tunnel stopped')
  })

  it('keeps the port held while the daemon is down: offline answers, no other program can take it', async () => {
    const T = home('t5')
    homes.push(T)
    T.run(['net', 'host', '--tunnel', 'cloudflared', '--port', '0'], { ...env, AGENT_BRIDGE_TUNNEL_GRACE_MS: '60000' })
    const port = Number(/Local port: (\d+)/.exec(T.run(['net', 'status']))?.[1])
    const health = async (): Promise<number> => (await fetch(`http://127.0.0.1:${port}/v1/health`)).status
    expect(await health()).toBe(200)

    T.run(['restart'])
    await until(() => !fs.existsSync(path.join(T.dir, 'daemon.lock')), 'daemon down')
    expect(await health()).toBe(503)
    const squatter = net.createServer()
    const bind = await new Promise<string>(r => {
      squatter.once('error', (err: NodeJS.ErrnoException) => r(err.code ?? 'error'))
      squatter.listen(port, '127.0.0.1', () => r('bound'))
    })
    squatter.close()
    expect(bind).toBe('EADDRINUSE')

    // The next daemon adopts the keeper and is reachable through it again, on the same port.
    expect(T.run(['net', 'status'])).toContain(`Local port: ${port}`)
    expect(await health()).toBe(200)
    T.run(['net', 'stop', '--yes'])
  })

  it('stops the tunnel once the daemon has been gone a while, so the address stops forwarding', async () => {
    const T = home('t4')
    homes.push(T)
    T.run(['net', 'host', '--tunnel', 'cloudflared', '--port', '0'], env)
    const cloudflared = fakePids().at(-1) ?? 0
    expect(alive(cloudflared)).toBe(true)
    // Nothing in this home restarts the daemon, so it stays gone.
    T.run(['restart'])
    await until(() => !alive(cloudflared), 'tunnel stopped after the grace period', 20_000)
    expect(fs.readFileSync(path.join(T.dir, 'net', 'keeper.log'), 'utf8')).toMatch(/daemon has been gone/)
  })

  it('refuses both a public url and a tunnel, and an unknown tunnel', () => {
    const T = home('t2')
    homes.push(T)
    expect(T.fail(['net', 'host', '--tunnel', 'cloudflared', '--public-url', 'https://x.example'])).toMatch(/one of --public-url or --tunnel/)
    expect(T.fail(['net', 'host', '--tunnel', 'ngrok'])).toMatch(/not supported/)
  })

  it('says how to install cloudflared when it is missing', () => {
    const T = home('t3')
    homes.push(T)
    expect(T.fail(['net', 'host', '--tunnel', 'cloudflared', '--port', '0'], { AGENT_BRIDGE_CLOUDFLARED: path.join(dir, 'missing') })).toMatch(/cloudflared is not installed/)
    expect(T.run(['net', 'status'])).toMatch(/Not in a network/)
  })
})
