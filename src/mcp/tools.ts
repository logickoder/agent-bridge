import { z } from 'zod'
import { request } from '../client/index.js'
import { formatPeers, formatSent } from '../format.js'
import { defineTool, type Tool } from './server.js'
import { PeerKind, PeerName } from '../schema.js'

/** A server either speaks for one fixed peer (`self`) or takes the sender's name on every call (`as`). */
export type ToolContext = ({ self: string } | { asHelp: string }) & {
  /** The server's agent session, when it knows it. Sends then carry it and count as verified. */
  sessions?: string[]
}

export function bridgeTools(ctx: ToolContext): Tool[] {
  const self = 'self' in ctx ? ctx.self : undefined
  const asHelp = 'asHelp' in ctx ? ctx.asHelp : ''
  const send = defineTool({
    name: 'send',
    description: self
      ? `Send a message to another peer on agent-bridge. You are "${self}". It arrives live if the peer is listening, otherwise it waits in a queue. Use the peers tool to see names.`
      : `Send a message to another peer on agent-bridge. Pass \`as\`: ${asHelp}. It arrives live if the peer is listening, otherwise it waits in a queue.`,
    args: z.object({
      to: PeerName.optional().describe('Peer to send to. The peers tool lists names. Pass this or to_kind.'),
      to_kind: PeerKind.optional().describe(
        'Instead of to: the agent kind to send to. Picks the one online peer of that kind that joined from this folder, and fails if there are none or several.',
      ),
      text: z.string().trim().min(1, 'Message is empty.').describe('The message. Plain text or markdown.'),
      as: PeerName.optional().describe(
        self ? `Ignored. This session is always "${self}".` : `Your own peer name: ${asHelp}. Required.`,
      ),
    }),
    run: async args => {
      const from = self ?? args.as
      if (!from) throw new Error(`"as" is missing. This server does not know who you are. Pass ${asHelp}.`)
      if ((args.to === undefined) === (args.to_kind === undefined)) throw new Error('pass one of "to" or "to_kind". Name a peer, or a kind to reach the one in this folder.')
      // The server runs in the agent's working folder, the same folder join records.
      const target = args.to !== undefined ? { to: args.to } : { toKind: args.to_kind, folder: process.cwd() }
      const r = await request({ op: 'send', from, ...target, text: args.text, ...(ctx.sessions?.length ? { sessions: ctx.sessions } : {}) }, 'sent')
      return formatSent(r.to ?? args.to ?? '', r)
    },
  })

  const peers = defineTool({
    name: 'peers',
    description: 'List peers on agent-bridge who are online now. Offline peers are only counted; pass all for everyone with queue sizes.',
    args: z.object({ all: z.boolean().optional().describe('List offline peers too.') }),
    run: async args => {
      const { peers: list } = await request({ op: 'status' }, 'status')
      return formatPeers(list, { ...(args.all ? { all: true } : {}), ...(self ? { self } : {}) })
    },
  })

  return [send, peers]
}
