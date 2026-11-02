import { describe, expect, it } from 'vitest'
import { autoBase, inFamily, nextFree, sessionTag } from './names.js'
import { PeerName } from './schema.js'

describe('autoBase', () => {
  it('is <folder>-<kind>, slugged', () => {
    expect(autoBase('/Users/j/projects/bankstract', 'agy')).toBe('bankstract-agy')
    expect(autoBase('/x/My Project_v2', 'claude')).toBe('my-project-v2-claude')
  })

  it('falls back to the kind for a folder with no usable characters', () => {
    expect(autoBase('/', 'agy')).toBe('agy')
    expect(autoBase('/x/___', 'claude')).toBe('claude')
  })

  it('leaves room for a suffix inside the 32 character limit', () => {
    const base = autoBase(`/x/${'a'.repeat(60)}`, 'claude')
    expect(base.endsWith('-claude')).toBe(true)
    expect(PeerName.safeParse(`${base}-999`).success).toBe(true)
  })
})

describe('nextFree', () => {
  it('takes the base, then the lowest free suffix', () => {
    expect(nextFree('b-agy', new Set())).toBe('b-agy')
    expect(nextFree('b-agy', new Set(['b-agy']))).toBe('b-agy-2')
    expect(nextFree('b-agy', new Set(['b-agy', 'b-agy-2', 'b-agy-4']))).toBe('b-agy-3')
  })

  it('stops at -999, the room autoBase keeps', () => {
    const taken = new Set(['b', ...Array.from({ length: 998 }, (_, i) => `b-${i + 2}`)])
    expect(nextFree('b', taken)).toBeUndefined()
  })
})

describe('inFamily', () => {
  it('matches the base and its numbered suffixes only', () => {
    expect(inFamily('b-agy', 'b-agy')).toBe(true)
    expect(inFamily('b-agy-12', 'b-agy')).toBe(true)
    expect(inFamily('b-agy-x', 'b-agy')).toBe(false)
    expect(inFamily('b-agy2', 'b-agy')).toBe(false)
  })
})

describe('sessionTag', () => {
  it('is short, stable, and does not contain the session id', () => {
    expect(sessionTag('abc')).toBe(sessionTag('abc'))
    expect(sessionTag('abc')).not.toBe(sessionTag('abd'))
    expect(sessionTag('abc')).toMatch(/^[0-9a-f]{12}$/)
  })
})
