import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import type { Message } from '../../schema.js'
import { socketText } from './format.js'

/**
 * Default Claude delivery: post into the session's own inbox socket, the one Claude Code's cross-session
 * messaging uses (docs/agents/claude-code.md, finding 8). An idle session starts a turn. `join` reads the path from the
 * documented CLAUDE_CODE_MESSAGING_SOCKET. No auth line: the daemon is not the session's child, so Claude
 * applies its inbound controls (delivered in prompting sessions, held in bypass-permission ones). The line
 * format is undocumented; the monitor and channel paths remain as choices.
 */

export const SOCKET_ENV = 'CLAUDE_CODE_MESSAGING_SOCKET'
const CONNECT_TIMEOUT_MS = 5000

export type Connect = (socket: string) => Promise<Duplex>
/** Identifies the socket file itself, so a path reused by a later session reads as different. */
export type FileId = (socket: string) => string | undefined

/**
 * Inode and creation time. The path names the Claude process by pid, and pids get reused: a new session on
 * the same path creates a new socket file.
 */
const statFileId: FileId = socket => {
  try {
    const st = fs.statSync(socket, { bigint: true })
    return `${st.ino}:${st.birthtimeNs}`
  } catch {
    return undefined
  }
}

/** The push endpoint for this Claude session: its inbox socket path and file id. The token is deliberately left out. */
export function endpointFromEnv(env: NodeJS.ProcessEnv, fileId: FileId = statFileId): Record<string, string> | undefined {
  const socket = env[SOCKET_ENV]
  if (!socket || !path.isAbsolute(socket)) return undefined
  const file = fileId(socket)
  return file ? { socket, file } : { socket }
}

const connectUnix: Connect = socket =>
  new Promise((resolve, reject) => {
    const c = net.createConnection(socket)
    const timer = setTimeout(() => c.destroy(new Error(`connecting to ${socket} timed out.`)), CONNECT_TIMEOUT_MS)
    c.once('connect', () => {
      clearTimeout(timer)
      resolve(c)
    })
    c.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })

const Endpoint = z.object({
  socket: z.string().refine(s => path.isAbsolute(s), 'socket must be an absolute path'),
  /** The socket file's id at join. Absent when join could not stat it. */
  file: z.string().optional(),
})

/** Delivers one message as a peer message line, then closes. Resolves once the line is flushed. */
export const deliverWith =
  (connect: Connect, fileId: FileId = statFileId) =>
  async (endpoint: Record<string, string>, msg: Message): Promise<void> => {
    const { socket, file } = Endpoint.parse(endpoint)
    if (file !== undefined && fileId(socket) !== file) {
      throw new Error(`${socket} is no longer this session's socket. The session ended; another may use the path now.`)
    }
    const c = await connect(socket)
    const line = { type: 'user', message: { role: 'user', content: socketText(msg) }, from: `agent-bridge:${msg.from}` }
    await new Promise<void>((resolve, reject) => {
      c.once('error', reject)
      c.end(`${JSON.stringify(line)}\n`, () => resolve())
    })
  }

export const deliver = deliverWith(connectUnix)

/**
 * True if the socket file is the one the session joined with and it accepts a connection. Closes it without
 * writing a line. Without a file id there is no telling sessions apart, so it is false.
 */
export const aliveWith =
  (connect: Connect, fileId: FileId = statFileId) =>
  async (endpoint: Record<string, string>): Promise<boolean> => {
    const parsed = Endpoint.safeParse(endpoint)
    if (!parsed.success || parsed.data.file === undefined || fileId(parsed.data.socket) !== parsed.data.file) return false
    try {
      ;(await connect(parsed.data.socket)).destroy()
      return true
    } catch {
      return false
    }
  }

export const alive = aliveWith(connectUnix)
