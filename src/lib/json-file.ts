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

/** Reads a state file. A corrupt one is moved aside and reported through `log`, so the caller still starts. */
export function readOrSetAside<S extends z.ZodType>(file: string, schema: S, log: (msg: string) => void): z.infer<S> | undefined {
  const read = readJson(file, schema)
  if (read.status === 'ok') return read.value
  if (read.status === 'invalid') {
    const aside = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, aside)
    log(`${file} ${read.reason}. Moved to ${aside}.`)
  }
  return undefined
}

/**
 * Writes JSON atomically (temp file, then rename), creating the directory. A crash never leaves half a file.
 * `mode`: the file's permissions from the moment it exists, e.g. 0o600 for keys.
 */
export function writeJson(file: string, data: unknown, opts: { pretty?: boolean; mode?: number } = {}): void {
  // Private files get a private directory. Other callers write into other tools' folders: leave those alone.
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(opts.mode !== undefined ? { mode: 0o700 } : {}) })
  const text = opts.pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data)
  const tmp = `${file}.tmp`
  if (opts.mode !== undefined) {
    // A temp file left by a crash may have other permissions. Start fresh so `mode` applies.
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(tmp, text, { mode: opts.mode })
  } else fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * Every `<name>.json` in `dir` whose name passes `name`, read with `readOrSetAside`: undefined where the file was
 * unreadable or invalid (and moved aside). Nothing when the folder does not exist.
 */
export function readJsonDir<S extends z.ZodType>(dir: string, name: z.ZodType<string>, schema: S, log: (msg: string) => void): [string, z.infer<S> | undefined][] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json') && name.safeParse(f.slice(0, -'.json'.length)).success)
    .map(f => [f.slice(0, -'.json'.length), readOrSetAside(path.join(dir, f), schema, log)])
}
