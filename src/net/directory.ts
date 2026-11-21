import { b64u, concat, sign, verify } from './crypto.js'
import type { DirMember, Directory } from './schema.js'

/**
 * The host's signature on the member list. It proves the host sent this list. It does not prove the keys in it
 * are genuine: a dishonest host can sign a swapped key. Only fingerprints compared out of band catch that.
 */

export type UnsignedDirectory = Omit<Directory, 'sig'>

function canonical(d: UnsignedDirectory): Buffer {
  const members = d.members.map((m: DirMember) => concat(m.handle, m.x, m.e, m.sig, m.online ? '1' : '0', m.host ? '1' : '0'))
  return concat('ab/v1/directory', d.netId, d.network, String(d.epoch), d.url, String(d.urlSeq), ...members)
}

export function signDirectory(hostE: Uint8Array, d: UnsignedDirectory): Directory {
  return { ...d, sig: b64u.encode(sign(hostE, canonical(d))) }
}

export function verifyDirectory(hostEPub: Uint8Array, d: Directory): boolean {
  const { sig, ...rest } = d
  return verify(hostEPub, canonical(rest), b64u.decode(sig))
}
