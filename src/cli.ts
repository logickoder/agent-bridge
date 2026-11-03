#!/usr/bin/env node
import { ADAPTERS } from './adapters/index.js'
import type { Command } from './adapters/types.js'
import { request, resolveName, stopDaemon } from './client/index.js'
import { formatPeers, formatSent } from './format.js'
import { peerKind, peerName, takeFlag, takeSwitch } from './lib/args.js'
import { toError } from './lib/errors.js'
import { logger } from './lib/log.js'
import { sessionTag } from './names.js'
import { HOME } from './paths.js'
import { PeerKind } from './schema.js'

const adapters = Object.values(ADAPTERS)
const adapterCommands = new Map<string, Command>(adapters.flatMap(a => Object.entries(a.commands)))

const USAGE = [
  'usage: agent-bridge <command>',
  '',
  '  install | uninstall            set up or remove PATH links and every agent\'s config',
  '  status                         peers, bindings, queues',
  '  join [name] [--kind k] [--no-push] [--take]  bind this session\'s name (auto: <folder>-<kind>; a name renames); --take: take a name online elsewhere',
  '  peers [--all]                  who is online (offline ones counted; --all lists everyone)',
  '  whoami                         this session\'s peer name(s), from the agent\'s session id',
  '  send [--as me] <to|--to-kind k> <text...>  send; --to-kind: the one online peer of that kind in this folder',
  '  leave <name>                   unbind a peer and stop its listeners',
  '  restart                        stop the daemon; the next client starts the new one',
  `  mcp <kind>                     MCP server for one agent kind: ${adapters.map(a => a.kind).join(', ')}`,
  ...adapters.flatMap(a => Object.values(a.commands).map(c => `  ${c.usage}`)),
  '  daemon                         hub process (auto-started)',
].join('\n')

/** The agent sessions this shell belongs to, from each adapter's session env var. */
function envSessions(): { adapter: (typeof adapters)[number]; id: string }[] {
  return adapters.flatMap(adapter => {
    const id = process.env[adapter.sessionEnv]
    return id ? [{ adapter, id }] : []
  })
}

/** The one agent whose session id is in this shell. Ambiguous or none: ask for --kind. */
function sessionAdapter(): (typeof adapters)[number] {
  const found = envSessions().map(s => s.adapter)
  const [only] = found
  if (only && found.length === 1) return only
  const why = found.length ? `this shell has session ids for ${found.map(a => a.kind).join(' and ')}` : 'this shell has no agent session id'
  throw new Error(`cannot tell which agent this is: ${why}. Pass --kind ${adapters.map(a => a.kind).join('|')}.`)
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'daemon':
      return (await import('./daemon/server.js')).runDaemon()
    case 'mcp': {
      const kind = PeerKind.safeParse(args[0])
      if (!kind.success) throw new Error(`mcp needs an agent kind: ${adapters.map(x => x.kind).join(', ')}. Got "${args[0] ?? ''}".`)
      return ADAPTERS[kind.data].serveMcp()
    }
    case 'send': {
      // Only a leading --as is ours. Everything after the recipient is message text, flags included.
      const from = args[0] === '--as' ? peerName(args[1], '--as') : 'shell'
      const rest = args[0] === '--as' ? args.slice(2) : args
      // --to-kind <kind> instead of a name: the daemon picks the one online peer of that kind in this folder.
      const byKind = rest[0] === '--to-kind'
      const words = byKind ? rest.slice(2) : rest.slice(1)
      const target = byKind ? { toKind: peerKind(rest[1], '--to-kind'), folder: process.cwd() } : { to: peerName(rest[0], 'Recipient') }
      // The agent sessions this shell belongs to. The daemon checks `from` against them. Without --as the
      // sender is plain `shell`, which no session holds, so no session is attached and it goes unverified.
      const sessions = args[0] !== '--as' ? [] : envSessions().map(s => s.id)
      const r = await request({ op: 'send', from, ...target, text: words.join(' '), ...(sessions.length ? { sessions } : {}) }, 'sent')
      return out(formatSent(r.to ?? target.to ?? '', r))
    }
    case 'status': {
      const r = await request({ op: 'status' }, 'status')
      return out(JSON.stringify({ pid: r.pid, home: HOME, peers: r.peers }, null, 2))
    }
    case 'join': {
      const noPush = takeSwitch(args, '--no-push')
      const take = takeSwitch(args, '--take')
      const kindFlag = takeFlag(args, '--kind')
      const adapter = kindFlag === undefined ? sessionAdapter() : ADAPTERS[PeerKind.parse(kindFlag)]
      const cwd = process.cwd()
      const identity = args[0] === undefined ? { folder: cwd } : { name: peerName(args[0], 'Name') }
      const session = process.env[adapter.sessionEnv]
      const name = await resolveName(identity, adapter.kind, session, { take, folder: cwd })
      const endpoint = session && !noPush ? await adapter.pushEndpoint?.(process.env) : undefined
      let pushed = false
      let note = ''
      if (session && endpoint) {
        try {
          await request({ op: 'push', kind: adapter.kind, session, endpoint }, 'ok')
          pushed = true
        } catch (err) {
          note = `\nDirect delivery not registered: ${toError(err).message}`
        }
      }
      const { peers: list } = await request({ op: 'status' }, 'status')
      return out(`Joined agent-bridge as "${name}".\n${await adapter.joined(name, pushed)}${note}\n${formatPeers(list, { self: name, folder: cwd })}`)
    }
    case 'peers': {
      const { peers: list } = await request({ op: 'status' }, 'status')
      return out(formatPeers(list, { all: takeSwitch(args, '--all'), folder: process.cwd() }))
    }
    case 'whoami': {
      const sessions = envSessions().map(s => s.id)
      if (!sessions.length) throw new Error('no agent session id in this shell. Run whoami from inside an agent session.')
      const { peers } = await request({ op: 'status' }, 'status')
      const tags = sessions.map(sessionTag)
      const mine = peers.filter(p => p.session !== null && tags.includes(p.session))
      if (mine.length) return out(mine.map(p => p.name).join('\n'))
      return out(['This session is not on the bridge. To join:', ...adapters.map(a => `  ${a.joinHint}`)].join('\n'))
    }
    case 'leave': {
      const name = peerName(args[0], 'Peer name')
      await request({ op: 'leave', as: name }, 'ok')
      return out(`"${name}" left. Its listeners exited and the binding is released.`)
    }
    case 'restart': {
      await stopDaemon()
      return out('Daemon stopped. The next client starts it again. Waiting listeners reconnect.')
    }
    case 'install': {
      const { install, installContext } = await import('./install.js')
      for (const line of await install(installContext())) out(line)
      await stopDaemon()
      return out(['', 'Done. To join:', ...adapters.map(x => `  ${x.joinHint}`)].join('\n'))
    }
    case 'uninstall': {
      const { uninstall, installContext } = await import('./install.js')
      for (const line of await uninstall(installContext())) out(line)
      await stopDaemon()
      return out(`\nDone. Daemon state in ${HOME} is kept. Delete it by hand if you want it gone.`)
    }
    default: {
      const command = cmd === undefined ? undefined : adapterCommands.get(cmd)
      if (command) return command.run(args)
      process.stderr.write(`${USAGE}\n`)
      process.exit(2)
    }
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  logger()(toError(err).message)
  process.exit(1)
})
