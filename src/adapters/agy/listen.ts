import { streamListen } from '../../client/index.js'
import { logger } from '../../lib/log.js'
import { formatListened, stoppedNotice, supersededNotice } from './format.js'

const log = logger()

const print = (text: string, code = 0): void => {
  process.stdout.write(`${text}\n`, () => process.exit(code))
}

/** Blocks until one message for `as` arrives, prints it and exits 0. Reconnects across daemon restarts. */
export function listen(as: string, session: string | undefined): void {
  streamListen(
    { op: 'listen', as, kind: 'agy', stream: false, ...(session ? { session } : {}) },
    {
      write: msg => new Promise(resolve => process.stdout.write(`${formatListened(msg)}\n`, () => resolve())),
      // agy's own wording: the listener must tell agy not to re-arm.
      end: e => {
        if (e.type === 'superseded') return print(supersededNotice(e.by))
        if (e.type === 'stopped') return print(stoppedNotice)
        log(e.message)
        process.exit(1)
      },
    },
  )
}
