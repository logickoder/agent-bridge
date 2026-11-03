import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = process.env['AGENT_BRIDGE_HOME'] ?? path.join(os.homedir(), '.agent-bridge')
export const SOCK = path.join(HOME, 'bridge.sock')
export const QUEUE_DIR = path.join(HOME, 'queue')
export const PEERS_FILE = path.join(HOME, 'peers.json')
export const DAEMON_LOG = path.join(HOME, 'daemon.log')
export const DAEMON_LOCK = path.join(HOME, 'daemon.lock')
/** Push endpoints that hold no credential (Claude's inbox socket path), restored on daemon start. */
export const ENDPOINTS_FILE = path.join(HOME, 'endpoints.json')

/** The built CLI entry (dist/cli.js). Node resolves symlinks in module URLs, so this is the real path. */
export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')
export const REPO = path.dirname(path.dirname(CLI))

/** Creates the state directory, private to this user. */
export function ensureHome(): void {
  fs.mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(HOME, 0o700)
}
