import type { Message, PeerKind } from '../schema.js'

/** Where install writes. Adapters read their own config dirs from `env`. */
export interface InstallContext {
  /** Directory on PATH that holds the `agent-bridge` link. */
  binDir: string
  /** The `agent-bridge` executable on PATH: `binDir/agent-bridge`. */
  exe: string
  repo: string
  env: NodeJS.ProcessEnv
}

export interface Command {
  /** One usage line, e.g. `listen [--as name]   agy: wait for one message, print it, exit`. */
  usage: string
  run: (args: string[]) => void | Promise<void>
}

/**
 * Everything agent-specific. Members load their modules on call, so importing the registry stays cheap. The hub, daemon, tools and CLI core never branch on kind.
 * See docs/adding-an-agent.md.
 */
export interface Adapter {
  kind: PeerKind
  /** How a user joins from this agent, shown after install. */
  joinHint: string
  /** Env var holding this agent's session id in its shell, for `join` and `whoami`. */
  sessionEnv: string
  /** What `join` prints after the name: how this agent receives and sends from now on. */
  joined: (name: string, pushed: boolean) => Promise<string>
  /** A push endpoint from the agent's environment, registered by `join`. Absent: the agent receives by listening. */
  pushEndpoint?: (env: NodeJS.ProcessEnv) => Promise<Record<string, string> | undefined>
  /** Pushes one message through an endpoint from pushEndpoint. Runs in the daemon. */
  deliver?: (endpoint: Record<string, string>, msg: Message) => Promise<void>
  /** `agent-bridge mcp <kind>`: the MCP server this agent's client launches. */
  serveMcp: () => Promise<void>
  /** Extra CLI commands this agent needs (launcher, listener, hooks). Names must be unique across adapters. */
  commands: Record<string, Command>
  /** Writes this agent's config. Idempotent. Returns one line per change. */
  install: (ctx: InstallContext) => Promise<string[]>
  /** Removes only what install wrote. */
  uninstall: (ctx: InstallContext) => Promise<string[]>
}
