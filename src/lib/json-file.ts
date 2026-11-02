import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { errnoCode } from './errors.js'

export type JsonRead<T> = { status: 'missing' } | { status: 'invalid'; reason: string } | { status: 'ok'; value: T }

/** Reads and validates a JSON file. Callers decide what a missing or invalid file means. */
export function readJson<S extends z.ZodType>(file: string, schema: S): JsonRead<z.infer<S>> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { status: 'missing' }
    throw err
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'invalid', reason: 'is not valid JSON' }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) return { status: 'invalid', reason: `does not match the expected shape: ${z.prettifyError(parsed.error)}` }
  return { status: 'ok', value: parsed.data }
}

/** Writes JSON atomically (temp file, then rename), creating the directory. A crash never leaves half a file. */
export function writeJson(file: string, data: unknown, opts: { pretty?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = opts.pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data)
  fs.writeFileSync(`${file}.tmp`, text)
  fs.renameSync(`${file}.tmp`, file)
}
