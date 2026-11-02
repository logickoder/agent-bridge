import path from 'node:path'
import { MAX_PEER_NAME, type PeerKind } from './schema.js'

// Default peer names, the way Claude names sessions: from the project folder, never reused while taken.

/** Room kept for `-<n>`, up to -999. */
const SUFFIX_ROOM = 4

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** `<folder>-<kind>`, cut so a suffix still fits the peer name limit. */
export function autoBase(folder: string, kind: PeerKind): string {
  const room = MAX_PEER_NAME - SUFFIX_ROOM - kind.length - 1
  const head = slug(path.basename(folder)).slice(0, room).replace(/-+$/, '')
  return head ? `${head}-${kind}` : kind
}

const MAX_SUFFIX = 999

/** The base if free, else the lowest free `base-<n>` from 2. Undefined past -999, which autoBase keeps room for. */
export function nextFree(base: string, taken: ReadonlySet<string>): string | undefined {
  if (!taken.has(base)) return base
  for (let n = 2; n <= MAX_SUFFIX; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return undefined
}

/** Whether `name` is `base` or `base-<n>`. */
export function inFamily(name: string, base: string): boolean {
  return name === base || (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)))
}

/** Who a session is on the bridge: a chosen name, or its folder for an auto name the daemon assigns. */
export type Identity = { name: string } | { folder: string }
