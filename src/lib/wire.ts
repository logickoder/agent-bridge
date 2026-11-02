import type { Readable, Writable } from 'node:stream'

/** Calls `onValue` for each newline-delimited JSON value. Unparseable lines go to `onBadLine`. */
export function onLines(stream: Readable, onValue: (value: unknown) => void, onBadLine: (line: string) => void): void {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onBadLine(line)
        continue
      }
      onValue(value)
    }
  })
}

export function writeLine(stream: Writable, value: unknown, done?: () => void): void {
  if (stream.destroyed || stream.writableEnded) return
  stream.write(`${JSON.stringify(value)}\n`, done)
}
