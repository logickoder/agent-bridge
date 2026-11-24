import { z } from 'zod'
import { request, resolveName } from '../../client/index.js'
import { loadConfig, shouldAutoJoin } from '../../config.js'
import { sendGuide } from '../../format.js'
import { toError } from '../../lib/errors.js'
import { logger } from '../../lib/log.js'
import { parseHookInput, readStdin, writeLine } from '../../lib/wire.js'
import type { BridgeConfig } from '../../schema.js'
import { SESSION_ENV } from './names.js'
import { endpointFromEnv } from './socket.js'

/** Hard cap so a slow daemon never stalls Claude startup or exit. */
const HOOK_BUDGET_MS = 1500

const log = logger('claude-session')

const SessionInput = z
  .object({
    session_id: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    permission_mode: z.string().optional(),
  })
  .loose()

export interface SessionStartDeps {
  config: () => BridgeConfig
  endpoint: (env: NodeJS.ProcessEnv) => Record<string, string> | undefined
  join: (folder: string, session: string, endpoint: Record<string, string>) => Promise<string>
}

/**
 * Pure SessionStart decision: auto-joins the local bridge when enabled for `cwd`, unless the session
 * is in bypass-permissions mode or lacks a messaging socket. Returns hook JSON to print, or undefined.
 */
export async function sessionStartOutput(
  stdin: string,
  env: NodeJS.ProcessEnv,
  deps: SessionStartDeps,
): Promise<object | undefined> {
  const input = parseHookInput(stdin, SessionInput)
  if (!input) return undefined
  const { session_id, cwd, permission_mode } = input
  if (permission_mode === 'bypassPermissions') return undefined
  const folder = cwd ?? process.cwd()
  if (!shouldAutoJoin(deps.config(), folder)) return undefined
  const session = env[SESSION_ENV] ?? session_id
  const endpoint = deps.endpoint(env)
  if (!session || !endpoint) {
    log(`auto-join skipped: missing ${!session ? 'session id' : 'CLAUDE_CODE_MESSAGING_SOCKET'}.`)
    return undefined
  }
  const name = await deps.join(folder, session, endpoint)
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Auto-joined agent-bridge as "${name}". Messages from peers arrive directly in this session. Send with ${sendGuide(name)}. \`agent-bridge peers\` lists who is online.`,
    },
  }
}

/** Pure SessionEnd action: unbinds the session if a session id is present. */
export async function sessionEndAction(
  stdin: string,
  env: NodeJS.ProcessEnv,
  leave: (session: string) => Promise<void>,
): Promise<boolean> {
  const session = env[SESSION_ENV] ?? parseHookInput(stdin, SessionInput)?.session_id
  if (!session) return false
  await leave(session)
  return true
}

/** Claude Code SessionStart hook. Always exits 0; never blocks startup. */
export async function runSessionStart(): Promise<void> {
  let done = false
  const finish = (out?: object): Promise<void> => {
    if (done) return Promise.resolve()
    done = true
    if (!out) return Promise.resolve()
    return new Promise(resolve => writeLine(process.stdout, out, resolve))
  }
  setTimeout(() => void finish().then(() => process.exit(0)), HOOK_BUDGET_MS).unref()
  try {
    const out = await sessionStartOutput(await readStdin(), process.env, {
      config: loadConfig,
      endpoint: endpointFromEnv,
      join: async (folder, session, endpoint) => {
        const name = await resolveName({ folder }, 'claude', session, { folder })
        await request({ op: 'push', kind: 'claude', session, endpoint }, 'ok')
        return name
      },
    })
    await finish(out)
  } catch (err) {
    log(`auto-join failed: ${toError(err).message}`)
  }
  process.exit(0)
}

/** Claude Code SessionEnd hook. Releases the session binding without starting a stopped daemon. */
export async function runSessionEnd(): Promise<void> {
  setTimeout(() => process.exit(0), HOOK_BUDGET_MS).unref()
  try {
    await sessionEndAction(await readStdin(), process.env, async session => {
      await request({ op: 'leave', session }, 'ok', { spawnDaemon: false })
    })
  } catch (err) {
    log(`auto-leave failed: ${toError(err).message}`)
  }
  process.exit(0)
}
