import { streamListen } from '../../client/index.js'
import { endCode, endText } from '../../format.js'
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
  streamListen(
    { op: 'listen', kind: 'claude', session, stream: true },
    {
      write: msg => new Promise(resolve => process.stdout.write(`${monitorLine(msg)}\n`, () => resolve())),
      end: e => finish(endText(e), endCode(e)),
    },
  )
}
