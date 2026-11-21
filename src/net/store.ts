import fs from 'node:fs'
import path from 'node:path'
import { readJsonDir, readOrSetAside, writeJson } from '../lib/json-file.js'
import { logger } from '../lib/log.js'
import { NET_HOST, NET_IDENTITY, NET_LINK, NET_MAILBOX, NET_SERVER } from '../paths.js'
import { PeerName } from '../schema.js'
import { b64u, generateEd25519, generateX25519, publicOf } from './crypto.js'
import type { StaticKeys } from './handshake.js'
import type { LinkStore } from './link.js'
import type { RelayStore } from './relay.js'
import { HostState, Identity, LinkState, Mailbox, ServerConfig } from './schema.js'

/**
 * Network state on disk, under HOME/net. Every file is 0600: the identity holds private keys, and the rest
 * names members and holds sealed mail. A corrupt file is moved aside, like the rest of HOME.
 */

const log = logger('net')
const PRIVATE = { mode: 0o600 } as const

/** This daemon's keys, made on first use. */
export function loadIdentity(): StaticKeys {
  const saved = readOrSetAside(NET_IDENTITY, Identity, log)
  if (!saved) {
    const keys: StaticKeys = { x: generateX25519(), e: generateEd25519() }
    const id: Identity = {
      v: 1,
      x: { pub: b64u.encode(keys.x.pub), priv: b64u.encode(keys.x.priv) },
      e: { pub: b64u.encode(keys.e.pub), priv: b64u.encode(keys.e.priv) },
    }
    writeJson(NET_IDENTITY, id, PRIVATE)
    return keys
  }
  const keys: StaticKeys = {
    x: { pub: b64u.decode(saved.x.pub), priv: b64u.decode(saved.x.priv) },
    e: { pub: b64u.decode(saved.e.pub), priv: b64u.decode(saved.e.priv) },
  }
  if (!publicOf('x25519', keys.x.priv).equals(keys.x.pub) || !publicOf('ed25519', keys.e.priv).equals(keys.e.pub)) {
    throw new Error(`${NET_IDENTITY} holds keys that do not match. It was edited or damaged. Restore it from a backup, or move it away to make new keys (members then see a key change).`)
  }
  return keys
}

export const readHost = (): HostState | undefined => readOrSetAside(NET_HOST, HostState, log)
export const readLink = (): LinkState | undefined => readOrSetAside(NET_LINK, LinkState, log)
export const readServer = (): ServerConfig | undefined => readOrSetAside(NET_SERVER, ServerConfig, log)

export const writeServer = (c: ServerConfig): void => writeJson(NET_SERVER, c, PRIVATE)

const mailboxFile = (handle: string): string => path.join(NET_MAILBOX, `${PeerName.parse(handle)}.json`)

/** The relay's files. `initial` is used when there is no host file yet. */
export function relayFileStore(initial: HostState): RelayStore {
  return {
    load() {
      const state = readHost() ?? initial
      const mailboxes = new Map<string, Mailbox>()
      for (const [handle, box] of readJsonDir(NET_MAILBOX, PeerName, Mailbox, log)) if (box) mailboxes.set(handle, box)
      return { state, mailboxes }
    },
    saveState: s => writeJson(NET_HOST, s, PRIVATE),
    saveMailbox: (h, m) => writeJson(mailboxFile(h), m, PRIVATE),
    dropMailbox: h => fs.rmSync(mailboxFile(h), { force: true }),
  }
}

export const linkFileStore = (): LinkStore => ({ save: s => writeJson(NET_LINK, s, PRIVATE) })

/** Forgets the network: membership, and on the host its members and mail. The identity stays. */
export function clearNetwork(): void {
  for (const f of [NET_LINK, NET_HOST, NET_SERVER]) fs.rmSync(f, { force: true })
  fs.rmSync(NET_MAILBOX, { recursive: true, force: true })
}
