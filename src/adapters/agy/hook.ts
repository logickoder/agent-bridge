import { z } from 'zod'
import type { Message } from '../../schema.js'
import { request } from '../../client/index.js'
import { formatDrained } from './format.js'
import { toError } from '../../lib/errors.js'
import { logger } from '../../lib/log.js'
import { writeLine } from '../../lib/wire.js'

/** Hard cap so a slow or missing daemon never stalls agy. */
const HOOK_BUDGET_MS = 1500

const log = logger('hook')

const HookInput = z.object({ conversationId: z.string().min(1).optional() }).loose()

async function readStdin(): Promise<string> {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += String(chunk)
  return buf
}

/** Messages shown to this session, and how to remove them from the queue once they are printed. */
export interface Drained {
  msgs: Message[]
  ack: () => Promise<void>
}

export interface HookResult {
  out: object
  /** Present when the output carries messages. Call only after the output is written. */
  ack?: () => Promise<void>
}

/** What the hook prints for a given stdin and daemon. Never throws. */
export async function hookOutput(stdin: string, drain: (session: string) => Promise<Drained>): Promise<HookResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin)
  } catch {
    return { out: {} }
  }
  const parsed = HookInput.safeParse(input)
  const session = parsed.success ? parsed.data.conversationId : undefined
  if (!session) return { out: {} }
  const d = await drain(session).catch((err: unknown) => {
    // Fail open: agy must keep running. Log to stderr and inject nothing.
    log(`drain failed: ${toError(err).message}`)
    return undefined
  })
  if (!d?.msgs.length) return { out: {} }
  return { out: { injectSteps: [{ userMessage: formatDrained(d.msgs) }] }, ack: d.ack }
}

/**
 * agy PreInvocation hook. Must never stall agy: hard time cap, `{}` on any failure.
 * Messages leave the queue only after they are printed. If the cap hits first, they stay queued.
 */
export async function runHook(): Promise<void> {
  let printed = false
  const print = (out: object): Promise<void> => {
    if (printed) return Promise.resolve()
    printed = true
    return new Promise(resolve => writeLine(process.stdout, out, resolve))
  }
  setTimeout(() => void print({}).then(() => process.exit(0)), HOOK_BUDGET_MS).unref()
  const { out, ack } = await hookOutput(await readStdin(), async session => {
    const { msgs } = await request({ op: 'drain', session }, 'drained', { spawnDaemon: false })
    const ids = msgs.map(m => m.id)
    return { msgs, ack: () => request({ op: 'ack-drained', session, ids }, 'ok', { spawnDaemon: false }).then(() => {}) }
  })
  if (printed) return process.exit(0)
  await print(out)
  // Not acked means shown again next turn: a duplicate, never a loss.
  await ack?.().catch((err: unknown) => log(`ack failed, messages will show again: ${toError(err).message}`))
  process.exit(0)
}
