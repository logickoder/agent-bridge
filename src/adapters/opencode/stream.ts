import { streamListen } from '../../client/index.js'
import { endCode, endText } from '../../format.js'
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
  streamListen(
    { op: 'listen', kind: 'opencode', session, stream: true },
    {
      write: msg => new Promise(resolve => writeLine(process.stdout, { type: 'message', text: deliveredText(msg) }, resolve)),
      end: e => finish(endText(e), endCode(e)),
    },
  )
}
