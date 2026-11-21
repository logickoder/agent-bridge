import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { b64u, sha256 } from './crypto.js'
import { Invite } from './schema.js'

/**
 * Invites are data the CLI parses, never a page an agent reads. `agent-bridge-invite:1:<b64u json>.<checksum>`.
 * The checksum catches a truncated paste. It is not a security check: the token and the pinned host keys are.
 */

const PREFIX = 'agent-bridge-invite:1:'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const checksum = (body: string): string => b64u.encode(sha256(body).subarray(0, 4))

/** https anywhere, or http on loopback only (tests, and a tunnel that terminates on this machine). */
export function urlProblem(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `"${url}" is not a URL.`
  }
  if (u.protocol === 'https:') return undefined
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return undefined
  return `"${url}" must be https, or http on 127.0.0.1. Use the URL your tunnel prints.`
}

export function encodeInvite(invite: Invite): string {
  const body = b64u.encode(Buffer.from(JSON.stringify(Invite.parse(invite))))
  return `${PREFIX}${body}.${checksum(body)}`
}

export type DecodedInvite = { ok: true; invite: Invite } | { ok: false; error: string }

const INCOMPLETE = 'The invite is incomplete or changed. Ask the host for a new one with `agent-bridge net invite`.'

export function decodeInvite(text: string, now: Date): DecodedInvite {
  const s = text.replace(/\s+/g, '')
  if (!s.startsWith(PREFIX)) return { ok: false, error: `Not an agent-bridge invite. It starts with "${PREFIX}".` }
  const [body, sum, extra] = s.slice(PREFIX.length).split('.')
  if (body === undefined || sum === undefined || extra !== undefined || checksum(body) !== sum) return { ok: false, error: INCOMPLETE }
  let json: unknown
  try {
    json = JSON.parse(b64u.decode(body).toString('utf8'))
  } catch {
    return { ok: false, error: INCOMPLETE }
  }
  const parsed = Invite.safeParse(json)
  if (!parsed.success) return { ok: false, error: `The invite is malformed: ${z.prettifyError(parsed.error)}. Ask the host for a new one.` }
  const problem = urlProblem(parsed.data.url)
  if (problem) return { ok: false, error: problem }
  if (Date.parse(parsed.data.exp) <= now.getTime()) return { ok: false, error: 'The invite expired. Ask the host for a new one with `agent-bridge net invite`.' }
  return { ok: true, invite: parsed.data }
}

export const newToken = (): string => b64u.encode(randomBytes(32))
export const hashToken = (token: string): string => sha256(token).toString('hex')

/** Constant-time compare of a token against a stored hash. */
export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
