import os from 'node:os'
import { request } from '../client/index.js'
import { peerName, takeFlag, takeSwitch } from '../lib/args.js'
import { readStdin } from '../lib/wire.js'
import { sessionTag } from '../names.js'
import { formatAgentLevels, keyChoiceRefused, raiseRefused, verifyRefused } from './format.js'
import { AllowLevel, MAX_PEER_NAME, PeerName, type NetCommand } from '../schema.js'

/** What `net` needs from the core CLI: this shell's agent session ids, and where to print. */
export interface NetCliContext {
  sessions: () => string[]
  out: (line: string) => void
  /** Asks the person at the terminal. Undefined when there is no terminal to ask. */
  confirm: (question: string) => Promise<string | undefined>
}

const NET_USAGE = [
  'usage: agent-bridge net <sub>',
  '  host --public-url URL [--name N] [--handle H] [--port P]   host a network here; your tunnel forwards URL to 127.0.0.1:P',
  '  host --public-url URL --socket [...]  same, but your tunnel forwards to the daemon\'s socket file: no port at all',
  '  host --tunnel cloudflared [...]     host behind a free trial tunnel (its address changes when it restarts)',
  '  invite [--ttl HOURS] [--handle H]   a single-use invite (host only)',
  '  connect <invite|->                  join with an invite; - reads it from stdin',
  '  status                              network, members, fingerprints',
  '  fingerprint                         your code, to read to the other members',
  '  verify <handle> <code>              mark a member checked after comparing codes',
  '  trust <handle>                      accept a member\'s changed key (stays unverified)',
  '  allow <handle> ask|chat|work [--for HOURS] [--agents a,b]  what that member\'s agents may do here without asking you',
  '  kick <handle>                       remove a member (host only)',
  '  share|unshare [name]                let members reach this session, or stop',
  '  set-url <update|url> [--unsigned]   host: move to url. member: apply the host\'s signed update',
  '  leave                               leave the network (member)',
  '  stop --yes                          end the network for everyone (host)',
].join('\n')
const DEFAULT_PORT = 7787
const DEFAULT_TTL_HOURS = 24
const HOUR_MS = 3600_000

/** `agent-bridge net <sub>`. Loaded on demand from cli.ts. */
export async function runNet(args: string[], ctx: NetCliContext): Promise<void> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'share':
    case 'unshare':
      return share(rest[0], sub === 'share', ctx)
    case undefined:
    case 'help':
      return ctx.out(NET_USAGE)
    default: {
      const cmd = await parse(sub, rest)
      if (!cmd) throw new Error(`Unknown net subcommand "${sub}".\n${NET_USAGE}`)
      // A message could talk an agent into raising a level for its sender. So only a shell outside any agent
      // session may raise one; lowering it to ask works anywhere.
      const sessions = ctx.sessions()
      if (cmd.cmd === 'allow' && cmd.level !== 'ask') {
        if (sessions.length) throw new Error(raiseRefused(cmd.handle, cmd.level))
        await confirmRaise(cmd.handle, cmd.level, ctx)
      }
      await confirmKeyChoice(cmd, sessions, ctx)
      const r = await request({ op: 'net', cmd, ...(sessions.length ? { sessions } : {}) }, 'net')
      return ctx.out(r.text)
    }
  }
}

/**
 * Raising a level asks the person at the terminal to type it back. An agent's shell has no terminal, so a message
 * cannot talk an agent into raising its sender's level with one command. Not a hard boundary: an agent running as
 * this user can fake a terminal. It makes the attempt deliberate and visible in its transcript.
 */
async function confirmTyped(want: string, question: string, what: string, rerun: string, ctx: NetCliContext): Promise<void> {
  const typed = await ctx.confirm(`${question} Type "${want}" to confirm: `)
  if (typed === undefined) {
    throw new Error(`${what} needs your terminal. It asks you to type it back, and this shell has none. Run \`agent-bridge net ${rerun}\` in your own terminal.`)
  }
  if (typed.trim() !== want) throw new Error(`The confirmation did not match "${want}". Nothing changed. Run the command again and type it exactly.`)
}

const confirmRaise = (handle: string, level: string, ctx: NetCliContext): Promise<void> =>
  confirmTyped(`${handle} ${level}`, `Raising ${handle} to ${level} lets their agents act here without asking you.`, 'Raising a level', `allow ${handle} ${level}`, ctx)


/**
 * Deciding on a key (verify, or trust a changed one) asks the person at the terminal, like a level raise: an agent
 * talked into it could copy the code `net status` prints into `net verify`, and a host in the middle can hand out
 * its own key from the start.
 */
async function confirmKeyChoice(cmd: NetCommand, sessions: string[], ctx: NetCliContext): Promise<void> {
  if (cmd.cmd === 'trust') {
    if (sessions.length) throw new Error(keyChoiceRefused(cmd.handle, `trust ${cmd.handle}`))
    return confirmTyped(`trust ${cmd.handle}`, `Trusting ${cmd.handle}'s new key without checking it lets whoever holds it read and send as ${cmd.handle}.`, 'Trusting a key', `trust ${cmd.handle}`, ctx)
  }
  if (cmd.cmd !== 'verify') return
  if (sessions.length) throw new Error(verifyRefused(cmd.handle))
  return confirmTyped(`verify ${cmd.handle}`, `Mark ${cmd.handle}'s key verified only if ${cmd.handle} read you this code themselves, by call or a separate chat.`, 'Verifying a key', `verify ${cmd.handle} ${cmd.code}`, ctx)
}

/** A handle from the login name, if it makes a valid one. The host may still pick another. */
function defaultHandle(): string | undefined {
  const name = os.userInfo().username.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, MAX_PEER_NAME)
  return PeerName.safeParse(name).success ? name : undefined
}


function number(value: string | undefined, what: string, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} "${value}" is not a number. Pass a whole number.`)
  return n
}

function noExtra(args: string[], sub: string): void {
  if (args.length) throw new Error(`net ${sub} does not take "${args.join(' ')}". See \`agent-bridge net help\`.`)
}

/** Turns argv into a command for the daemon. Undefined: not a daemon command. */
async function parse(sub: string, args: string[]): Promise<NetCommand | undefined> {
  switch (sub) {
    case 'host': {
      const url = takeFlag(args, '--public-url')
      const tunnel = takeFlag(args, '--tunnel')
      const socket = takeSwitch(args, '--socket')
      const name = takeFlag(args, '--name') ?? 'network'
      const handle = peerName(takeFlag(args, '--handle') ?? defaultHandle() ?? 'host', 'Handle')
      const port = number(takeFlag(args, '--port'), '--port', DEFAULT_PORT)
      noExtra(args, sub)
      if (tunnel !== undefined && tunnel !== 'cloudflared') throw new Error(`--tunnel "${tunnel}" is not supported. Use --tunnel cloudflared, or run your own tunnel and pass --public-url.`)
      if ((url === undefined) === (tunnel === undefined)) {
        throw new Error(
          'net host needs one of --public-url or --tunnel. --public-url: the https address of a tunnel you run (a named Cloudflare tunnel, Tailscale Funnel, or ngrok reserved domain). --tunnel cloudflared: a free trial tunnel whose address changes when it restarts.',
        )
      }
      if (socket && url === undefined) throw new Error('--socket goes with --public-url. A trial tunnel cannot reach a socket file, so it uses a port.')
      return { cmd: 'host', name, handle, port, socket, ...(url !== undefined ? { url } : { tunnel: 'cloudflared' as const }) }
    }
    case 'invite': {
      const ttl = number(takeFlag(args, '--ttl'), '--ttl', DEFAULT_TTL_HOURS)
      const handle = takeFlag(args, '--handle')
      noExtra(args, sub)
      return { cmd: 'invite', ttlMs: Math.round(ttl * HOUR_MS), ...(handle !== undefined ? { handle: peerName(handle, 'Handle') } : {}) }
    }
    case 'connect': {
      const flag = takeFlag(args, '--handle')
      const [given, ...extra] = args
      noExtra(extra, sub)
      if (given === undefined) throw new Error('net connect needs the invite. Pass it, or `-` to read it from stdin.')
      const invite = given === '-' ? (await readStdin()).trim() : given
      const handle = flag ?? defaultHandle()
      return { cmd: 'connect', invite, ...(handle !== undefined ? { handle: peerName(handle, 'Handle') } : {}) }
    }
    case 'verify': {
      const [handle, ...code] = args
      if (!code.length) throw new Error('net verify needs a handle and the code that member read to you: `agent-bridge net verify <handle> <code>`.')
      return { cmd: 'verify', handle: peerName(handle, 'Handle'), code: code.join(' ') }
    }
    case 'trust':
    case 'kick': {
      const [handle, ...extra] = args
      noExtra(extra, sub)
      return { cmd: sub, handle: peerName(handle, 'Handle') }
    }
    case 'allow': {
      const hours = takeFlag(args, '--for')
      const only = takeFlag(args, '--agents')
      const [handle, level, ...extra] = args
      noExtra(extra, sub)
      const parsed = AllowLevel.safeParse(level)
      if (!parsed.success) throw new Error('net allow needs a handle and a level: `agent-bridge net allow <handle> ask|chat|work`. ask: check with you first. chat: answer from what they know. work: also read files and run read-only commands in the folder.')
      const forMs = hours === undefined ? undefined : Math.round(number(hours, '--for', 0) * HOUR_MS)
      if (forMs !== undefined && parsed.data === 'ask') throw new Error('--for goes with chat or work: ask does not lapse.')
      if (only !== undefined && parsed.data === 'ask') throw new Error('--agents goes with chat or work: ask already covers every agent.')
      const agents = only?.split(',').map(a => peerName(a.trim(), 'Agent name'))
      return { cmd: 'allow', handle: peerName(handle, 'Handle'), level: parsed.data, ...(forMs !== undefined ? { forMs } : {}), ...(agents?.length ? { agents } : {}) }
    }
    case 'set-url': {
      const unsigned = takeSwitch(args, '--unsigned')
      const [value, ...extra] = args
      noExtra(extra, sub)
      if (value === undefined) throw new Error('net set-url needs the line the host sent you, or a URL on the host.')
      return { cmd: 'set-url', value, unsigned }
    }
    case 'stop': {
      const yes = takeSwitch(args, '--yes')
      noExtra(args, sub)
      if (!yes) throw new Error('net stop deletes the network: every member and all waiting mail. Members are cut off. Run `agent-bridge net stop --yes` to go ahead.')
      return { cmd: 'stop' }
    }
    case 'status':
    case 'fingerprint':
    case 'leave':
      noExtra(args, sub)
      return { cmd: sub }
    default:
      return undefined
  }
}

/** The name to share: the one given, or the one this session holds. */
async function ownName(given: string | undefined, sessions: string[]): Promise<string> {
  if (given !== undefined) return peerName(given, 'Name')
  const { peers } = await request({ op: 'status' }, 'status')
  const tags = sessions.map(sessionTag)
  const mine = peers.filter(p => p.session !== null && tags.includes(p.session)).map(p => p.name)
  const [only, ...more] = mine
  if (only && !more.length) return only
  if (only) throw new Error(`This session holds ${mine.join(', ')}. Pass the one to share: \`agent-bridge net share <name>\`.`)
  throw new Error('This session is not on the bridge. Join first with /bridge or `agent-bridge join`, then share.')
}

async function share(given: string | undefined, on: boolean, ctx: NetCliContext): Promise<void> {
  const sessions = ctx.sessions()
  if (!sessions.length) throw new Error('No agent session id in this shell. Run share from inside the agent session you want to share.')
  const name = await ownName(given, sessions)
  await request({ op: 'share', as: name, sessions, on }, 'ok')
  const { network } = await request({ op: 'status' }, 'status')
  if (!on) return ctx.out(`"${name}" is no longer shared. Other members of the network cannot reach it.`)
  const where = network ? `Members of network "${network.name}" can now message it as ${name}@${network.self}.` : 'There is no network yet. It becomes reachable once you host or join one.'
  const levels = network ? formatAgentLevels((await request({ op: 'net', cmd: { cmd: 'status' } }, 'net')).info?.members ?? [], name) : ''
  ctx.out(`"${name}" is shared. ${where} Messages from them are marked as another user's agent.${levels ? ` ${levels}` : ''}`)
}
