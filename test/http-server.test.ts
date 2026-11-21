import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { generateEd25519, generateX25519 } from '../src/net/crypto.js'
import { buildJoin, buildOpen, type StaticKeys } from '../src/net/handshake.js'
import { startNetServer, type NetServer } from '../src/net/http-server.js'
import { newHostState, Relay } from '../src/net/relay.js'
import type { Mailbox } from '../src/net/schema.js'
import { PollWaits } from '../src/net/waits.js'

// The host's HTTP server on a real port, with a memory-backed relay.

const servers: NetServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function setup() {
  const host: StaticKeys = { x: generateX25519(), e: generateEd25519() }
  let state = newHostState('team', 'alice', 'https://x.example', randomBytes)
  const boxes = new Map<string, Mailbox>()
  const relay = new Relay({
    store: {
      load: () => ({ state: structuredClone(state), mailboxes: boxes }),
      saveState: s => {
        state = structuredClone(s)
      },
      saveMailbox: () => {},
      dropMailbox: () => {},
    },
    host,
    now: () => new Date(),
    random: randomBytes,
  })
  const waits = new PollWaits((ms, fn) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  })
  const server = await startNetServer({ relay, waits, log: () => {} }, { port: 0 })
  servers.push(server)
  const post = async (path: string, body: unknown): Promise<number> =>
    (await fetch(`http://127.0.0.1:${server.port ?? 0}${path}`, { method: 'POST', body: JSON.stringify(body) })).status
  return { host, relay, post, server }
}

describe('net http server', () => {
  it('answers health, and 404 for any unknown path or failed join', async () => {
    const { post, server } = await setup()
    expect((await fetch(`http://127.0.0.1:${server.port ?? 0}/v1/health`)).status).toBe(200)
    expect(await post('/v1/nope', {})).toBe(404)
    expect(await post('/v1/join', { v: 1 })).toBe(404)
  })

  it('refuses a body over the route limit', async () => {
    const { post } = await setup()
    expect(await post('/v1/open', { pad: 'x'.repeat(10_000) })).toBe(413)
  })

  it('keeps a member able to reconnect while strangers flood the open route', async () => {
    const { host, relay, post } = await setup()
    const me: StaticKeys = { x: generateX25519(), e: generateEd25519() }
    const inv = relay.invite(3600_000, relay.url)
    const { req } = buildJoin({ me, netId: inv.netId, hostX: host.x.pub, token: inv.token, handle: 'bob', salt: randomBytes(16) })
    expect(await post('/v1/join', req)).toBe(200)

    const stranger = (): unknown => buildOpen({ me: generateX25519(), netId: relay.netId, hostX: host.x.pub, csid: randomBytes(16), now: new Date() })
    const flood = await Promise.all(Array.from({ length: 60 }, () => post('/v1/open', stranger())))
    expect(flood).toContain(429)

    const mine = buildOpen({ me: me.x, netId: relay.netId, hostX: host.x.pub, csid: randomBytes(16), now: new Date() })
    expect(await post('/v1/open', mine)).toBe(200)
  })
})
