import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { home, until, type Home } from './harness.js'
import { startProxy, type Proxy } from './proxy.js'

// How a tunnel the user runs reaches the host: a port the keeper holds, or the daemon's socket file.

const homes: Home[] = []
let proxy: Proxy

beforeAll(async () => {
  proxy = await startProxy()
})

afterAll(async () => {
  await Promise.all(homes.map(h => h.dispose()))
  await proxy.close()
}, 30_000)

const status = (port: number): Promise<number> => fetch(`http://127.0.0.1:${port}/v1/health`).then(r => r.status)
const tryBind = (port: number): Promise<string> =>
  new Promise(resolve => {
    const s = net.createServer()
    s.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve('bound')))
  })
const daemonDown = (h: Home): Promise<void> => until(() => !fs.existsSync(path.join(h.dir, 'daemon.lock')), 'daemon down')

describe('hosting behind your own tunnel', { timeout: 40_000 }, () => {
  it('port: the keeper holds the port across a daemon restart, answers offline, and frees it on stop', async () => {
    const H = home('hp')
    homes.push(H)
    const out = H.run(['net', 'host', '--public-url', 'https://team.example', '--port', '0'])
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+), held by the port keeper/.exec(out)?.[1])
    expect(port).toBeGreaterThan(0)
    expect(await status(port)).toBe(200)

    H.run(['restart'])
    await daemonDown(H)
    expect(await status(port)).toBe(503)
    expect(await tryBind(port)).toBe('EADDRINUSE')

    expect(H.run(['net', 'status'])).toContain(`Local port: ${port}`)
    expect(await status(port)).toBe(200)

    H.run(['net', 'stop', '--yes'])
    // The keeper exits on its own after the stop signal: wait for the port, up to a few seconds.
    let bind = await tryBind(port)
    for (let i = 0; bind !== 'bound' && i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      bind = await tryBind(port)
    }
    expect(bind).toBe('bound')
  })

  it('port: refuses a port another program holds, and leaves nothing behind', async () => {
    const squatter = net.createServer()
    const port = await new Promise<number>(r =>
      squatter.listen(0, '127.0.0.1', () => {
        const a = squatter.address()
        r(a !== null && typeof a === 'object' ? a.port : 0)
      }),
    )
    const H = home('hb')
    homes.push(H)
    expect(H.fail(['net', 'host', '--public-url', 'https://team.example', '--port', String(port)])).toMatch(new RegExp(`Port ${port} is in use`))
    expect(H.run(['net', 'status'])).toMatch(/Not in a network/)
    squatter.close()
  })

  it('socket: no port at all; a tunnel pointed at the socket file carries a member in', async () => {
    const H = home('hs')
    homes.push(H)
    const sock = path.join(H.dir, 'net', 'http.sock')
    const out = H.run(['net', 'host', '--public-url', `http://127.0.0.1:${proxy.port}`, '--socket', '--handle', 'alice'])
    expect(out).toContain(`Listening on the socket ${sock}`)
    expect(out).toContain(`service: unix:${sock}`)
    expect(H.run(['net', 'status'])).toContain(`Socket: ${sock}`)
    expect(fs.existsSync(path.join(H.dir, 'net', 'keeper.json'))).toBe(false)
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600)

    await proxy.setTarget(sock)
    const A = home('ms')
    homes.push(A)
    expect(A.run(['net', 'connect', H.run(['net', 'invite']).split('\n')[0] ?? '', '--handle', 'bob'])).toMatch(/as bob/)
    await until(() => /bob +online/.test(H.run(['net', 'status'])), 'bob online at the host')

    // With the daemon down there is nothing to connect to: the socket file is gone, not taken.
    H.run(['restart'])
    await daemonDown(H)
    const code = await new Promise<string>(resolve => {
      const req = http.get({ socketPath: sock, path: '/v1/health' }, () => resolve('answered'))
      req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'))
    })
    expect(['ENOENT', 'ECONNREFUSED']).toContain(code)
  })

  it('refuses --socket with a trial tunnel', () => {
    const H = home('hx')
    homes.push(H)
    expect(H.fail(['net', 'host', '--tunnel', 'cloudflared', '--socket'])).toMatch(/--socket goes with --public-url/)
  })
})
