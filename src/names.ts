import path from 'node:path'
import type { PeerKind } from './schema.js'

// Default peer names, the way Claude names sessions: from the project folder, never reused while taken.

const MAX_NAME = 32
/** Room kept for `-<n>`, up to -999. */
const SUFFIX_ROOM = 4

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** `<folder>-<kind>`, cut so a suffix still fits the peer name limit. */
export function autoBase(folder: string, kind: PeerKind): string {
  const room = MAX_NAME - SUFFIX_ROOM - kind.length - 1
  const head = slug(path.basename(folder)).slice(0, room).replace(/-+$/, '')
  return head ? `${head}-${kind}` : kind
}

/** The base if free, else the lowest free `base-<n>` from 2. */
export function nextFree(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** Whether `name` is `base` or `base-<n>`. */
export function inFamily(name: string, base: string): boolean {
  return name === base || (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)))
}
