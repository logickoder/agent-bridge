import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import type { Message } from '../../schema.js'
import { socketText } from './format.js'

/**
 * Default Claude delivery: post into the session's own inbox socket, the one Claude Code's cross-session
 * messaging uses (Claude finding 8). An idle session starts a turn. `join` reads the path from the
 * documented CLAUDE_CODE_MESSAGING_SOCKET. No auth line: the daemon is not the session's child, so Claude
 * applies its inbound controls (delivered in prompting sessions, held in bypass-permission ones). The line
 * format is undocumented; the monitor and channel paths remain as choices.
 */

export const SOCKET_ENV = 'CLAUDE_CODE_MESSAGING_SOCKET'
const CONNECT_TIMEOUT_MS = 5000

export type Connect = (socket: string) => Promise<Duplex>

/** The push endpoint for this Claude session: its inbox socket path. The token is deliberately left out. */
export function endpointFromEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const socket = env[SOCKET_ENV]
  if (!socket || !path.isAbsolute(socket)) return undefined
  return { socket }
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

const Endpoint = z.object({ socket: z.string().refine(s => path.isAbsolute(s), 'socket must be an absolute path') })

/** Delivers one message as a peer message line, then closes. Resolves once the line is flushed. */
export const deliverWith =
  (connect: Connect) =>
  async (endpoint: Record<string, string>, msg: Message): Promise<void> => {
    const { socket } = Endpoint.parse(endpoint)
    const c = await connect(socket)
    const line = { type: 'user', message: { role: 'user', content: socketText(msg) }, from: `agent-bridge:${msg.from}` }
    await new Promise<void>((resolve, reject) => {
      c.once('error', reject)
      c.end(`${JSON.stringify(line)}\n`, () => resolve())
    })
  }

export const deliver = deliverWith(connectUnix)
