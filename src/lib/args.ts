import { PEER_KINDS, PeerKind, PeerName } from '../schema.js'

/** Removes `--flag value` from args and returns the value. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

/** Removes a boolean `--flag` from args and returns whether it was there. */
export function takeSwitch(args: string[], flag: string): boolean {
  const i = args.indexOf(flag)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}

/** Parses a peer name with a readable error. */
export function peerName(value: string | undefined, what: string): string {
  const parsed = PeerName.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`${what} ${value === undefined ? 'is missing' : `"${value}" is invalid`}. ${parsed.error.issues[0]?.message ?? ''}`.trim())
}

/** Parses a kind id with a readable error that lists the kinds. */
export function peerKind(value: string | undefined, what: string): PeerKind {
  const parsed = PeerKind.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`${what} ${value === undefined ? 'is missing a kind' : `"${value}" is not a kind`}. Kinds: ${PEER_KINDS.join(', ')}.`)
}
