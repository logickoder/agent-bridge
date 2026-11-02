import { holdListen } from '../../client/index.js'
import { toError } from '../../lib/errors.js'
import { writeLine } from '../../lib/wire.js'
import { deliveredText } from './format.js'
import { SESSION_ENV } from './names.js'

/** One JSON line, then exit. */
const finish = (text: string, code: number): void => {
  writeLine(process.stdout, { type: 'notice', text: `[agent-bridge] ${text}` }, () => process.exit(code))
}

/**
 * The plugin's stream child: listens on whatever name the session holds and prints one JSON line per message,
 * `{"type":"message","text":...}`. The plugin prompts each into the session. Exits when stdin closes, which
 * happens when opencode exits.
 */
export function runStream(env: NodeJS.ProcessEnv = process.env): void {
  const session = env[SESSION_ENV]
  if (!session) return finish(`no ${SESSION_ENV}. The agent-bridge plugin starts this; it is not meant to run by hand.`, 1)
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
  holdListen(
    { op: 'listen', kind: 'opencode', session, stream: true },
    {
      onMessage: msg =>
        new Promise(resolve => {
          writeLine(process.stdout, { type: 'message', text: deliveredText(msg) }, resolve)
        }),
      onControl: reply => {
        if (reply.type === 'superseded') finish(`another session (${reply.by}) took over this name. This session no longer receives.`, 0)
        else if (reply.type === 'stopped') finish('this session left the bridge. It no longer receives.', 0)
        else if (reply.type === 'error') finish(reply.message, 1)
        return true
      },
      onError: err => finish(toError(err).message, 1),
    },
  )
}
