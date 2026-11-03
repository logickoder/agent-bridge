import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Store } from './hub.js'
import { readJson, writeJson } from '../lib/json-file.js'
import { logger } from '../lib/log.js'
import { ENDPOINTS_FILE, ensureHome, PEERS_FILE, QUEUE_DIR } from '../paths.js'
import { Message, Peer, PeerName, SavedEndpoint } from '../schema.js'

const log = logger('store')

/** Reads a state file. A corrupt one is moved aside so the daemon still starts. */
function readOrSetAside<S extends z.ZodType>(file: string, schema: S): z.infer<S> | undefined {
  const read = readJson(file, schema)
  if (read.status === 'ok') return read.value
  if (read.status === 'invalid') {
    const aside = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, aside)
    log(`${file} ${read.reason}. Moved to ${aside}.`)
  }
  return undefined
}

export function fileStore(): Store {
  return {
    load() {
      ensureHome()
      const stored = readOrSetAside(PEERS_FILE, z.array(Peer))
      const peers = stored ?? []
      if (!stored) writeJson(PEERS_FILE, peers)
      const queues = new Map<string, Message[]>()
      for (const f of fs.readdirSync(QUEUE_DIR)) {
        const name = f.replace(/\.json$/, '')
        if (!f.endsWith('.json') || !PeerName.safeParse(name).success) continue
        queues.set(name, readOrSetAside(path.join(QUEUE_DIR, f), z.array(Message)) ?? [])
      }
      const endpoints = readOrSetAside(ENDPOINTS_FILE, z.array(SavedEndpoint)) ?? []
      return { peers, queues, endpoints }
    },
    savePeers: peers => writeJson(PEERS_FILE, peers),
    saveQueue: (name, msgs) => writeJson(path.join(QUEUE_DIR, `${name}.json`), msgs),
    saveEndpoints: endpoints => writeJson(ENDPOINTS_FILE, endpoints),
    dropQueue: name => fs.rmSync(path.join(QUEUE_DIR, `${name}.json`), { force: true }),
  }
}
