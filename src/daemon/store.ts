import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Store } from './hub.js'
import { readJsonDir, readOrSetAside, writeJson } from '../lib/json-file.js'
import { logger } from '../lib/log.js'
import { ENDPOINTS_FILE, ensureHome, NET_OUTBOX, PEERS_FILE, QUEUE_DIR } from '../paths.js'
import { Message, Peer, PeerName, RemoteAddress, SavedEndpoint } from '../schema.js'
import { isOutboxKey } from './hub.js'

const log = logger('store')

/** Local peer queues live in `queue/`, network outbox queues in `net/outbox/`. */
const queueFile = (name: string): string => path.join(isOutboxKey(name) ? NET_OUTBOX : QUEUE_DIR, `${name}.json`)

function loadQueues(dir: string, valid: z.ZodType<string>, into: Map<string, Message[]>): void {
  for (const [name, queue] of readJsonDir(dir, valid, z.array(Message), log)) into.set(name, queue ?? [])
}

export function fileStore(): Store {
  return {
    load() {
      ensureHome()
      const stored = readOrSetAside(PEERS_FILE, z.array(Peer), log)
      const peers = stored ?? []
      if (!stored) writeJson(PEERS_FILE, peers)
      const queues = new Map<string, Message[]>()
      loadQueues(QUEUE_DIR, PeerName, queues)
      loadQueues(NET_OUTBOX, RemoteAddress, queues)
      const endpoints = readOrSetAside(ENDPOINTS_FILE, z.array(SavedEndpoint), log) ?? []
      return { peers, queues, endpoints }
    },
    savePeers: peers => writeJson(PEERS_FILE, peers),
    // Outbox messages are for another user's agent: private like everything else under net/.
    saveQueue: (name, msgs) => writeJson(queueFile(name), msgs, isOutboxKey(name) ? { mode: 0o600 } : {}),
    saveEndpoints: endpoints => writeJson(ENDPOINTS_FILE, endpoints),
    dropQueue: name => fs.rmSync(queueFile(name), { force: true }),
  }
}
