import type { Readable, Writable } from 'node:stream'
import type { z } from 'zod'

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

/** Reads all of stdin as text. For hooks, which get one JSON document on stdin. */
export async function readStdin(): Promise<string> {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += String(chunk)
  return buf
}

/** Parses a hook's stdin (empty counts as `{}`) against `schema`. Undefined when it is not JSON or does not match. */
export function parseHookInput<S extends z.ZodType>(stdin: string, schema: S): z.infer<S> | undefined {
  try {
    const parsed = schema.safeParse(stdin.trim() ? JSON.parse(stdin) : {})
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
