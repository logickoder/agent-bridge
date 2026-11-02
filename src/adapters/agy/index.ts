import { peerName, takeFlag } from '../../lib/args.js'
import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

// Modules load per command: the hook runs on every agy model call and must not load the rest.

/**
 * agy (Antigravity CLI) adapter.
 * Wake: `join` registers agy's agentapi endpoint and the daemon pushes each message into the conversation
 * with `agy agentapi send-message`, which wakes an idle agy. Fallbacks: a background `listen` whose exit
 * wakes agy, and a PreInvocation hook that injects queued messages at the next model call.
 * Identity: agy sets ANTIGRAVITY_CONVERSATION_ID in run_command's environment, and hooks receive the
 * same id as `conversationId`. That ties a peer name to one agy session. `join --kind agy` binds a name
 * to it: the one given, or `<folder>-agy[-n]`.
 */

export const agy: Adapter = {
  kind: 'agy',
  joinHint: 'agy: type `/bridge [name]`.',
  sessionEnv: SESSION_ENV,
  joined: async (name, pushed) => (await import('./format.js')).joinedText(name, pushed),
  pushEndpoint: async env => (await import('./push.js')).endpointFromEnv(env),
  deliver: async (endpoint, msg) => (await import('./push.js')).deliver(endpoint, msg),
  serveMcp: async () => (await import('./mcp.js')).serveAgyMcp(),
  commands: {
    listen: {
      usage: 'listen --as <name>             agy: wait for one message, print it, exit',
      run: async args => {
        const flag = takeFlag(args, '--as')
        if (flag === undefined) throw new Error('listen needs --as <name>. Run `agent-bridge join --kind agy` first; it prints the name.')
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
