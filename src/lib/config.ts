import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { errnoCode } from './errors.js'
import { readJson, writeJson } from './json-file.js'

// Helpers for editing other tools' config files without touching entries we do not own.

export const JsonObject = z.record(z.string(), z.unknown())
export type JsonObject = z.infer<typeof JsonObject>

/** Reads another tool's config. Missing: undefined. Invalid: a readable error, never a silent overwrite. */
export function readObject<S extends z.ZodType<JsonObject>>(file: string, schema: S): z.infer<S> | undefined {
  const read = readJson(file, schema)
  if (read.status === 'missing') return undefined
  if (read.status === 'invalid') throw new Error(`${file} ${read.reason}. Fix or move it, then rerun.`)
  return read.value
}

export function writeObject(file: string, data: JsonObject): void {
  writeJson(file, data, { pretty: true })
}

/** Points `dst` at `src`. Replaces an existing symlink, refuses to replace a real file. */
export function linkBin(dst: string, src: string): void {
  let current: string | undefined
  try {
    current = fs.readlinkSync(dst)
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'EINVAL') throw new Error(`${dst} exists and is not a symlink. Remove it, then rerun.`)
    if (code !== 'ENOENT') throw err
  }
  if (current === src) return
  if (current !== undefined) fs.unlinkSync(dst)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.symlinkSync(src, dst)
}

/** Removes `dst` only if it is our symlink to `src`. Returns whether it did. */
export function unlinkBin(dst: string, src: string): boolean {
  let target: string | undefined
  try {
    target = fs.readlinkSync(dst)
  } catch {
    return false
  }
  if (target !== src) return false
  fs.unlinkSync(dst)
  return true
}

/** First executable `name` on PATH. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return file
    } catch {
      // not here
    }
  }
  return undefined
}
