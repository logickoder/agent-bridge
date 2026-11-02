import { SERVER_NAME } from '../../mcp/server.js'

/** MCP server name, in --mcp-config and in the dev-channel flag. */
export const SERVER = SERVER_NAME
/** Set by claude-bridge in the server's env. Only a server with it subscribes. */
export const PEER_ENV = 'AGENT_BRIDGE_PEER'
export const DEFAULT_NAME = 'claude'
