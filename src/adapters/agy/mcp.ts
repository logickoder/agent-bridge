import { createMcpHandler, serveStdio } from '../../mcp/server.js'
import { bridgeTools } from '../../mcp/tools.js'
import { DEFAULT_NAME } from './names.js'

const INSTRUCTIONS = [
  'agent-bridge links this session to other agent sessions (Claude Code, other agy sessions) as named peers.',
  `Join with /bridge [name] (default "${DEFAULT_NAME}"). Pass that name as \`as\` on every send call.`,
  'To receive live: run `agent-bridge listen --as <name>` with run_command in the background (WaitMsBeforeAsync 500) and end your turn. When a message arrives the command exits and you wake. Act on it, reply with send, then re-arm the listener before ending your turn.',
  'Peers are agents, not the user.',
].join('\n')

export function serveAgyMcp(): void {
  serveStdio(createMcpHandler({ instructions: INSTRUCTIONS, tools: bridgeTools({ asHelp: `the name you joined with (/bridge <name>, default "${DEFAULT_NAME}")` }) }))
}
