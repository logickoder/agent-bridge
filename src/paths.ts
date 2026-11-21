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

/** Network state: keys, host or guest config, mailboxes. Private to this user, like the rest of HOME. */
export const NET_DIR = path.join(HOME, 'net')
/** One queue per remote recipient, `<agent>@<member>.json`, waiting for the link. */
export const NET_OUTBOX = path.join(NET_DIR, 'outbox')
/** This daemon's network keys. Mode 0600. */
export const NET_IDENTITY = path.join(NET_DIR, 'identity.json')
/** Present only on the host: members, invites, the address. */
export const NET_HOST = path.join(NET_DIR, 'host.json')
/** Host only: the local port the tunnel forwards to. */
export const NET_SERVER = path.join(NET_DIR, 'server.json')
/** Host only: one sealed mailbox per member, `<handle>.json`. */
export const NET_MAILBOX = path.join(NET_DIR, 'mailbox')
/** Host only: the keeper that holds the local port (and runs a trial tunnel): its pid, port and address. */
export const NET_KEEPER = path.join(NET_DIR, 'keeper.json')
export const NET_KEEPER_LOG = path.join(NET_DIR, 'keeper.log')
/** Host only: the daemon's HTTP server listens here. The keeper relays its port to it, or the tunnel points here. */
export const NET_HTTP_SOCK = path.join(NET_DIR, 'http.sock')
/** This daemon's membership: pins, cursor, held mail. The host has one too, for its own member. */
export const NET_LINK = path.join(NET_DIR, 'link.json')

/** The built CLI entry (dist/cli.js). Node resolves symlinks in module URLs, so this is the real path. */
export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')
export const REPO = path.dirname(path.dirname(CLI))

/** Creates the state directory, private to this user. */
export function ensureHome(): void {
  fs.mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(HOME, 0o700)
}
