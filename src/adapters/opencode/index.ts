import type { Adapter } from '../types.js'
import { SESSION_ENV } from './names.js'

// Modules load per command, like every adapter.

/**
 * opencode adapter (docs/agents/opencode.md, findings 1 to 3).
 * Wake: the agent-bridge plugin runs inside opencode. After bridge_join it starts `agent-bridge opencode-stream`
 * for the session and hands each message to ctx.session.prompt, which wakes an idle session.
 * Identity: the plugin passes the tool call's sessionID to the CLI as OPENCODE_SESSION_ID. `join --kind opencode`
 * binds the name: the one given, or `<folder>-opencode[-n]`.
 */

export const opencode: Adapter = {
  kind: 'opencode',
  joinHint: 'opencode: ask it to join the bridge (it calls the bridge_join tool).',
  sessionEnv: SESSION_ENV,
  joined: async () => (await import('./format.js')).joinedText(),
  serveMcp: async () => {
    throw new Error('opencode uses the agent-bridge plugin, not an MCP server.')
  },
  commands: {
    'opencode-stream': {
      usage: 'opencode-stream                opencode: plugin stream, one JSON line per message for this session',
      run: async () => (await import('./stream.js')).runStream(),
    },
  },
  install: async ctx => (await import('./install.js')).install(ctx),
  uninstall: async ctx => (await import('./install.js')).uninstall(ctx),
}
