import { holdListen } from '../../client/index.js'
import { formatListened, stoppedNotice, supersededNotice } from './format.js'
import { logger } from '../../lib/log.js'

const log = logger()

const print = (text: string, code = 0): void => {
  process.stdout.write(`${text}\n`, () => process.exit(code))
}

/** Blocks until one message for `as` arrives, prints it and exits 0. Reconnects across daemon restarts. */
export function listen(as: string, session: string | undefined): void {
  holdListen(
    { op: 'listen', as, kind: 'agy', stream: false, ...(session ? { session } : {}) },
    {
      onMessage: msg =>
        new Promise(resolve => {
          process.stdout.write(`${formatListened(msg)}\n`, () => resolve())
        }),
      onControl: reply => {
        if (reply.type === 'superseded') print(supersededNotice(reply.by))
        else if (reply.type === 'stopped') print(stoppedNotice)
        else if (reply.type === 'error') {
          log(reply.message)
          process.exit(1)
        }
        return true
      },
      onError: err => {
        log(err.message)
        process.exit(1)
      },
    },
  )
}
