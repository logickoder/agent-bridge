import { spawn } from 'node:child_process'
import { peerName } from '../../lib/args.js'
import { logger } from '../../lib/log.js'
import { autoBase } from '../../names.js'
import { CLI } from '../../paths.js'
import { BASE_ENV, PEER_ENV, SERVER, type Identity } from './names.js'

/** Arguments for `claude`: load only this server, for this session only, with the channel enabled. */
export function claudeArgs(identity: Identity, passthrough: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const serverEnv: Record<string, string> = 'name' in identity ? { [PEER_ENV]: identity.name } : { [BASE_ENV]: identity.base }
  const home = env['AGENT_BRIDGE_HOME']
  if (home) serverEnv['AGENT_BRIDGE_HOME'] = home
  const config = { mcpServers: { [SERVER]: { command: process.execPath, args: [CLI, 'mcp', 'claude'], env: serverEnv } } }
  return ['--mcp-config', JSON.stringify(config), '--dangerously-load-development-channels', `server:${SERVER}`, ...passthrough]
}

/** Splits `[--as <name>] [claude args...]`. */
export function parseLaunchArgs(argv: string[]): { name?: string; passthrough: string[] } {
  if (argv[0] !== '--as') return { passthrough: argv }
  // Only a leading --as is ours. Anything after belongs to claude.
  return { name: peerName(argv[1], '--as'), passthrough: argv.slice(2) }
}

export function launchClaude(argv: string[]): void {
  const { name, passthrough } = parseLaunchArgs(argv)
  const identity: Identity = name ? { name } : { base: autoBase(process.cwd(), 'claude') }
  const child = spawn('claude', claudeArgs(identity, passthrough), { stdio: 'inherit' })
  // Claude owns the terminal. Let it handle Ctrl-C.
  process.on('SIGINT', () => {})
  child.on('error', err => {
    logger()(`could not start claude: ${err.message}. Check that \`claude\` is on PATH.`)
    process.exit(1)
  })
  child.on('exit', code => process.exit(code ?? 1))
}
