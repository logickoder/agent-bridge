import { spawn } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { Message } from '../../schema.js'
import { onPath } from '../../lib/config.js'
import { formatPushed } from './format.js'
import { SESSION_ENV } from './names.js'

/**
 * Direct delivery into a live agy conversation with `agy agentapi send-message` (docs/agents/antigravity.md, finding 8). It wakes an
 * idle agy. Undocumented, so the listener and the hook stay as fallbacks. agy sets the address and CSRF token
 * in run_command's environment; `join` captures them, and the daemon keeps them in memory only.
 */

const DELIVER_TIMEOUT_MS = 10_000

export type Run = (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string }>


/** The push endpoint for this agy conversation, if run_command's environment has everything agentapi needs. */
export function endpointFromEnv(
  env: NodeJS.ProcessEnv,
  find: (name: string) => string | undefined = name => onPath(name, env),
): Record<string, string> | undefined {
  const address = env['ANTIGRAVITY_LS_ADDRESS']
  const token = env['ANTIGRAVITY_CSRF_TOKEN']
  const conversation = env[SESSION_ENV]
  const agy = find('agy')
  if (!address || !token || !conversation || !agy) return undefined
  return { address, token, conversation, agy }
}

const Endpoint = z.object({ address: z.string(), token: z.string(), conversation: z.string(), agy: z.string() })
const AgentApiOutput = z.object({ error: z.string().optional() }).loose()

const runProcess: Run = (exe, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: DELIVER_TIMEOUT_MS })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout }))
  })

/** Delivers one message. The token travels in the child's environment, never in its arguments. */
export const deliverWith =
  (run: Run) =>
  async (endpoint: Record<string, string>, msg: Message): Promise<void> => {
    const ep = Endpoint.parse(endpoint)
    // The endpoint comes over the socket. Run only an absolute path to an executable named agy.
    if (!path.isAbsolute(ep.agy)) throw new Error(`push endpoint's agy must be an absolute path, got "${ep.agy}".`)
    if (path.basename(ep.agy) !== 'agy') throw new Error(`push delivery only runs agy, not "${ep.agy}".`)
    const env = { ...process.env, ANTIGRAVITY_LS_ADDRESS: ep.address, ANTIGRAVITY_CSRF_TOKEN: ep.token }
    const { code, stdout } = await run(ep.agy, ['agentapi', 'send-message', ep.conversation, formatPushed(msg)], env)
    if (code !== 0) throw new Error(`agy agentapi send-message failed: exit ${code}.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('agy agentapi send-message printed no JSON. Its interface may have changed.')
    }
    const out = AgentApiOutput.safeParse(parsed)
    if (out.success && out.data.error) throw new Error(`agy agentapi send-message: ${out.data.error}`)
  }

export const deliver = deliverWith(runProcess)
