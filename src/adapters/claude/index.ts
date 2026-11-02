import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

/**
 * Claude Code adapter.
 * Wake, default: the agent-bridge plugin's monitor (`agent-bridge monitor`), started by /bridge. Each message
 * is one line, which Claude Code delivers as a monitor event that wakes an idle session.
 * Wake, opt-in: a channel push in a session launched with `agent-bridge claude`.
 * Identity: CLAUDE_CODE_SESSION_ID. `join --kind claude` binds the name: the one given, or `<folder>-claude[-n]`.
 */

export const claude: Adapter = {
  kind: 'claude',
  joinHint: 'Claude: type `/bridge [name]` (or `agent-bridge claude [--as name]` for a channel).',
  sessionEnv: SESSION_ENV,
  joined: async name => (await import('./format.js')).joinedText(name),
  serveMcp: async () => {
    const { identityFromEnv, serveClaudeMcp } = await import('./mcp.js')
    await serveClaudeMcp(identityFromEnv(process.env))
  },
  commands: {
    monitor: {
      usage: 'monitor                        claude: plugin monitor, one line per message for this session',
      run: async () => (await import('./monitor.js')).runMonitor(),
    },
    claude: {
      usage: 'claude [--as name] [args...]   launch Claude Code with a channel instead of the plugin monitor',
      run: async args => (await import('./launch.js')).launchClaude(args),
    },
  },
  install: async ctx => (await import('./install.js')).install(ctx),
  uninstall: async ctx => (await import('./install.js')).uninstall(ctx),
}
