import { holdListen } from '../../client/index.js'
import { toError } from '../../lib/errors.js'
import { monitorLine, monitorNotice } from './format.js'
import { SESSION_ENV } from './names.js'

/** Write one monitor line, then exit with `code`. */
const finish = (text: string, code: number): void => {
  process.stdout.write(`${monitorNotice(text)}\n`, () => process.exit(code))
}

/**
 * The plugin monitor: listens on whatever name this session holds (waiting for `join` if none yet), and
 * prints one line per message. Claude Code turns each line into a monitor event, which wakes an idle session.
 */
export function runMonitor(env: NodeJS.ProcessEnv = process.env): void {
  const session = env[SESSION_ENV]
  if (!session) return finish(`no ${SESSION_ENV} in the monitor's environment. This session cannot receive.`, 1)
  holdListen(
    { op: 'listen', kind: 'claude', session, stream: true },
    {
      onMessage: msg =>
        new Promise(resolve => {
          process.stdout.write(`${monitorLine(msg)}\n`, () => resolve())
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
