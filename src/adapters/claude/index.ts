import type { Adapter } from '../types.js'

/**
 * Claude Code adapter.
 * Wake: channel push (`notifications/claude/channel`) into a session started with the dev-channel flag.
 * Identity: the peer name from `claude-bridge --as`, passed to the MCP server as AGENT_BRIDGE_PEER.
 */

export const claude: Adapter = {
  kind: 'claude',
  joinHint: 'Claude: run `claude-bridge [--as name]`.',
  serveMcp: async () => {
    const { selfFromEnv, serveClaudeMcp } = await import('./mcp.js')
    serveClaudeMcp(selfFromEnv(process.env))
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
