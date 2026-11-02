import { z } from 'zod'
import { request } from '../client/index.js'
import { formatSent } from '../format.js'
import { defineTool, type Tool } from './server.js'
import { PeerName } from '../schema.js'

/** A server either speaks for one fixed peer (`self`) or takes the sender's name on every call (`as`). */
export type ToolContext = { self: string } | { asHelp: string }

export function bridgeTools(ctx: ToolContext): Tool[] {
  const self = 'self' in ctx ? ctx.self : undefined
  const asHelp = 'asHelp' in ctx ? ctx.asHelp : ''
  const send = defineTool({
    name: 'send',
    description: self
      ? `Send a message to another peer on agent-bridge. You are "${self}". It arrives live if the peer is listening, otherwise it waits in a queue. Use the peers tool to see names.`
      : `Send a message to another peer on agent-bridge. Pass \`as\`: ${asHelp}. It arrives live if the peer is listening, otherwise it waits in a queue.`,
    args: z.object({
      to: PeerName.describe('Peer to send to. The peers tool lists names.'),
      text: z.string().trim().min(1, 'Message is empty.').describe('The message. Plain text or markdown.'),
      as: PeerName.optional().describe(
        self ? `Ignored. This session is always "${self}".` : `Your own peer name: ${asHelp}. Required.`,
      ),
    }),
    run: async args => {
      const from = self ?? args.as
      if (!from) throw new Error(`"as" is missing. This server does not know who you are. Pass ${asHelp}.`)
      const r = await request({ op: 'send', from, to: args.to, text: args.text }, 'sent')
      return formatSent(args.to, r)
    },
  })

  const peers = defineTool({
    name: 'peers',
    description: 'List peers on agent-bridge: name, kind, whether they are listening now, and queued messages.',
    args: z.object({}),
    run: async () => {
      const { peers: list } = await request({ op: 'status' }, 'status')
      if (!list.length) return 'No peers yet. Peers appear here once they join the bridge.'
      return list
        .map(p => `${p.name} (${p.kind}) ${p.online ? 'listening' : 'offline'}, ${p.queued} queued${p.name === self ? ', you' : ''}`)
        .join('\n')
    },
  })

  return [send, peers]
}
