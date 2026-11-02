import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { z } from 'zod'
import { Hub, type Conn } from './hub.js'
import { acquireLock } from './lock.js'
import { logger } from '../lib/log.js'
import { DAEMON_LOCK, ensureHome, SOCK } from '../paths.js'
import { Request, type Reply } from '../schema.js'
import { fileStore } from './store.js'
import { onLines, writeLine } from '../lib/wire.js'

const log = logger('daemon', { timestamps: true })

function socketConn(sock: net.Socket): Conn {
  return {
    send: (reply: Reply) => writeLine(sock, reply),
    end: () => sock.end(),
    get closed() {
      return sock.destroyed || sock.writableEnded
    },
  }
}

export function runDaemon(): void {
  ensureHome()
  if (!acquireLock(DAEMON_LOCK, process.pid)) {
    log('another daemon holds the lock. Exiting.')
    return
  }
  const hub = new Hub({ store: fileStore(), now: () => new Date(), newId: () => randomUUID().slice(0, 8), pid: process.pid, log })

  const exit = (): never => {
    fs.rmSync(SOCK, { force: true })
    fs.rmSync(DAEMON_LOCK, { force: true })
    process.exit(0)
  }

  const server = net.createServer(sock => {
    const conn = socketConn(sock)
    sock.on('error', err => log(`client socket: ${err.message}`))
    sock.on('close', () => hub.disconnect(conn))
    onLines(
      sock,
      value => {
        const parsed = Request.safeParse(value)
        if (!parsed.success) {
          conn.send({ type: 'error', message: `invalid request: ${z.prettifyError(parsed.error)}. The client and daemon may be different builds. Run \`agent-bridge restart\`.` })
          return conn.end()
        }
        if (parsed.data.op === 'shutdown') {
          log('shutdown requested')
          conn.send({ type: 'ok' })
          conn.end()
          return void setTimeout(exit, 50)
        }
        hub.handle(parsed.data, conn)
      },
      line => log(`unparseable line: ${line.slice(0, 200)}`),
    )
  })

  server.on('error', err => {
    log(`server: ${err.message}`)
    fs.rmSync(DAEMON_LOCK, { force: true })
    process.exit(1)
  })
  fs.rmSync(SOCK, { force: true })
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600)
    log(`listening on ${SOCK} pid=${process.pid}`)
  })
  process.on('SIGINT', exit)
  process.on('SIGTERM', exit)
}
