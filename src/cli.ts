#!/usr/bin/env node
import { ADAPTERS } from './adapters/index.js'
import type { Command } from './adapters/types.js'
import { request, stopDaemon } from './client/index.js'
import { formatSent } from './format.js'
import { peerName } from './lib/args.js'
import { toError } from './lib/errors.js'
import { logger } from './lib/log.js'
import { HOME } from './paths.js'
import { PeerKind } from './schema.js'

const adapters = Object.values(ADAPTERS)
const adapterCommands = new Map<string, Command>(adapters.flatMap(a => Object.entries(a.commands)))

const USAGE = [
  'usage: agent-bridge <command>',
  '',
  '  install | uninstall            set up or remove PATH links and every agent\'s config',
  '  status                         peers, bindings, queues',
  '  send [--as me] <to> <text...>  send from the shell (sender "shell" by default)',
  '  leave <name>                   unbind a peer and stop its listeners',
  '  restart                        stop the daemon; the next client starts the new one',
  `  mcp <kind>                     MCP server for one agent kind: ${adapters.map(a => a.kind).join(', ')}`,
  ...adapters.flatMap(a => Object.values(a.commands).map(c => `  ${c.usage}`)),
  '  daemon                         hub process (auto-started)',
].join('\n')

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
      const [to, ...words] = args[0] === '--as' ? args.slice(2) : args
      const peer = peerName(to, 'Recipient')
      const r = await request({ op: 'send', from, to: peer, text: words.join(' ') }, 'sent')
      return out(formatSent(peer, r))
    }
    case 'status': {
      const r = await request({ op: 'status' }, 'status')
      return out(JSON.stringify({ pid: r.pid, home: HOME, peers: r.peers }, null, 2))
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
