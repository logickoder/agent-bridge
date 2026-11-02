import { describe, expect, it } from 'vitest'
import { PEER_KINDS } from '../schema.js'
import { ADAPTERS } from './index.js'

describe('ADAPTERS', () => {
  it('registers each kind under its own key', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...PEER_KINDS].sort())
    for (const [key, adapter] of Object.entries(ADAPTERS)) expect(adapter.kind).toBe(key)
  })

  it('gives every adapter command a unique name', () => {
    const names = Object.values(ADAPTERS).flatMap(a => Object.keys(a.commands))
    expect(new Set(names).size).toBe(names.length)
  })
})
