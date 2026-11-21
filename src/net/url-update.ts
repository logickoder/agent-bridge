import { z } from 'zod'
import { b64u, concat, sign, verify } from './crypto.js'
import { urlProblem } from './invite.js'
import { B64u } from './schema.js'

/**
 * A new host address, signed with the host key pinned at join. A guest cut off by an address change gets this
 * out of band and runs `net set-url <it>`. The signature and a rising `seq` mean a stranger's address, or an
 * old update replayed, cannot redirect the guest.
 */

const PREFIX = 'agent-bridge-url:1:'

const UrlUpdate = z.object({ netId: B64u, url: z.string(), seq: z.number().int().positive(), ts: z.iso.datetime() })
export type UrlUpdate = z.infer<typeof UrlUpdate>

const signed = (u: UrlUpdate): Buffer => concat('ab/v1/url', u.netId, u.url, String(u.seq), u.ts)

export function encodeUrlUpdate(hostE: Uint8Array, u: UrlUpdate): string {
  return `${PREFIX}${b64u.encode(Buffer.from(JSON.stringify(u)))}.${b64u.encode(sign(hostE, signed(u)))}`
}

export type DecodedUrlUpdate = { ok: true; update: UrlUpdate } | { ok: false; error: string }

export interface UrlCheck {
  hostEPub: Uint8Array
  netId: string
  /** The highest seq this guest applied. */
  lastSeq: number
}

export function decodeUrlUpdate(text: string, check: UrlCheck): DecodedUrlUpdate {
  const s = text.replace(/\s+/g, '')
  if (!s.startsWith(PREFIX)) return { ok: false, error: `Not a signed address update. It starts with "${PREFIX}". Ask the host for the line \`agent-bridge net status\` prints.` }
  const [body, sig, extra] = s.slice(PREFIX.length).split('.')
  if (body === undefined || sig === undefined || extra !== undefined) return { ok: false, error: 'The address update is incomplete. Ask the host to send it again.' }
  let parsed: ReturnType<typeof UrlUpdate.safeParse>
  try {
    parsed = UrlUpdate.safeParse(JSON.parse(b64u.decode(body).toString('utf8')))
  } catch {
    return { ok: false, error: 'The address update is incomplete. Ask the host to send it again.' }
  }
  if (!parsed.success) return { ok: false, error: 'The address update is malformed. Ask the host to send it again.' }
  const u = parsed.data
  if (!verify(check.hostEPub, signed(u), b64u.decode(sig))) {
    return { ok: false, error: 'The address update is not signed by your network\'s host. Do not use it; it may come from someone else.' }
  }
  if (u.netId !== check.netId) return { ok: false, error: 'The address update is for another network.' }
  if (u.seq <= check.lastSeq) return { ok: false, error: 'This address update is older than the one in use. Ask the host for the current one.' }
  const problem = urlProblem(u.url)
  if (problem) return { ok: false, error: problem }
  return { ok: true, update: u }
}
