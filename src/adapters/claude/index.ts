import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

/**
 * Claude Code adapter. Three ways to receive; the user picks:
 * - socket (default): `/bridge` runs `join`, which registers the session's inbox socket. The daemon posts each
 *   message there; Claude shows it as a message from another session and an idle session wakes. socket.ts.
 * - monitor: `/bridge-monitor` runs `join --no-push` and starts the plugin monitor, one line per message. monitor.ts.
 * - channel: launch with `agent-bridge claude`; a channel push into the session. channel/.
 * Identity: CLAUDE_CODE_SESSION_ID. `join --kind claude` binds the name: the one given, or `<folder>-claude[-n]`.
 */

export const claude: Adapter = {
  kind: 'claude',
  joinHint: 'Claude: type `/bridge [name]` (or `agent-bridge claude [--as name]` for a channel).',
  sessionEnv: SESSION_ENV,
  joined: async (name, pushed) => (await import('./format.js')).joinedText(name, pushed),
  pushEndpoint: async env => (await import('./socket.js')).endpointFromEnv(env),
  deliver: async (endpoint, msg) => (await import('./socket.js')).deliver(endpoint, msg),
  serveMcp: async () => {
    const { identityFromEnv, serveClaudeMcp } = await import('./channel/mcp.js')
    await serveClaudeMcp(identityFromEnv(process.env))
  },
  commands: {
    monitor: {
      usage: 'monitor                        claude: plugin monitor, one line per message for this session',
      run: async () => (await import('./monitor.js')).runMonitor(),
    },
    claude: {
      usage: 'claude [--as name] [args...]   launch Claude Code with a channel instead of the plugin monitor',
      run: async args => (await import('./channel/launch.js')).launchClaude(args),
    },
  },
  install: async ctx => (await import('./install.js')).install(ctx),
  uninstall: async ctx => (await import('./install.js')).uninstall(ctx),
}
