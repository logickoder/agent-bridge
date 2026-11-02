import { peerName, takeFlag } from '../../lib/args.js'
import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

// Modules load per command: the hook runs on every agy model call and must not load the rest.

/**
 * agy (Antigravity CLI) adapter.
 * Wake: agy wakes from idle when a background run_command exits. `listen` blocks until a message
 * arrives, prints it and exits. A PreInvocation hook is the fallback when no listener is armed.
 * Identity: agy sets ANTIGRAVITY_CONVERSATION_ID in run_command's environment, and hooks receive the
 * same id as `conversationId`. That ties a peer name to one agy session. `join` without a name claims
 * `<folder>-agy[-n]` for it.
 */

export const agy: Adapter = {
  kind: 'agy',
  joinHint: 'agy: type `/bridge [name]`.',
  sessionEnv: SESSION_ENV,
  serveMcp: async () => (await import('./mcp.js')).serveAgyMcp(),
  commands: {
    join: {
      usage: 'join [name]                    agy: settle this session\'s name (auto: <folder>-agy) and print it',
      run: async args => {
        const identity = args[0] === undefined ? { folder: process.cwd() } : { name: peerName(args[0], 'Name') }
        process.stdout.write(`${await (await import('./join.js')).join(identity, process.env[SESSION_ENV])}\n`)
      },
    },
    listen: {
      usage: 'listen --as <name>             agy: wait for one message, print it, exit',
      run: async args => {
        const flag = takeFlag(args, '--as')
        if (flag === undefined) throw new Error('listen needs --as <name>. Run `agent-bridge join` first; it prints the name.')
        const as = peerName(flag, '--as')
        const session = takeFlag(args, '--session') ?? process.env[SESSION_ENV]
        ;(await import('./listen.js')).listen(as, session)
      },
    },
    'agy-hook': {
      usage: 'agy-hook                       agy PreInvocation hook',
      run: async () => (await import('./hook.js')).runHook(),
    },
  },
  install: async ctx => (await import('./install.js')).install(ctx),
  uninstall: async ctx => (await import('./install.js')).uninstall(ctx),
}
