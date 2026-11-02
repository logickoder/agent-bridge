import { SERVER_NAME } from '../../mcp/identity.js'

/** MCP server name, in --mcp-config and in the dev-channel flag. */
export const SERVER = SERVER_NAME
/** Set by claude-bridge for `--as <name>`. A server with it or FOLDER_ENV subscribes; one with neither never does. */
export const PEER_ENV = 'AGENT_BRIDGE_PEER'
/** Set by claude-bridge without `--as`: the project folder, for the auto name `<folder>-claude`. */
export const FOLDER_ENV = 'AGENT_BRIDGE_FOLDER'
/** Set by Claude Code for its MCP servers and shell. Keys the auto name, so a resumed session keeps it. */
export const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID'
