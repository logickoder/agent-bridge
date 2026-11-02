import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

/**
 * Claude Code adapter.
 * Wake: channel push (`notifications/claude/channel`) into a session started with the dev-channel flag.
 * Identity: `claude-bridge --as <name>`, or an auto name `<folder>-claude[-n]` claimed for
 * CLAUDE_CODE_SESSION_ID. claude-bridge passes either to the MCP server in its env.
 */

export const claude: Adapter = {
  kind: 'claude',
  joinHint: 'Claude: run `claude-bridge [--as name]`.',
  sessionEnv: SESSION_ENV,
  serveMcp: async () => {
    const { identityFromEnv, serveClaudeMcp } = await import('./mcp.js')
    await serveClaudeMcp(identityFromEnv(process.env))
  },
  commands: {
    claude: {
      usage: 'claude [--as name] [args...]   launch Claude Code on the bridge (what claude-bridge runs)',
      run: async args => (await import('./launch.js')).launchClaude(args),
    },
  },
  install: async ctx => (await import('./install.js')).install(ctx),
  uninstall: async ctx => (await import('./install.js')).uninstall(ctx),
}
