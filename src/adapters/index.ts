import type { PeerKind } from '../schema.js'
import { agy } from './agy/index.js'
import { claude } from './claude/index.js'
import type { Adapter } from './types.js'

/** One adapter per kind. A kind in PEER_KINDS without an adapter fails to compile. */
export const ADAPTERS: Record<PeerKind, Adapter> = { claude, agy }
