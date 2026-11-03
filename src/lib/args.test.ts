import { describe, expect, it } from 'vitest'
import { peerKind, takeFlag, takeSwitch } from './args.js'

describe('takeSwitch', () => {
  it('removes a boolean flag and reports it, leaving the rest in order', () => {
    const args = ['--no-push', 'name', '--take']
    expect(takeSwitch(args, '--take')).toBe(true)
    expect(takeSwitch(args, '--all')).toBe(false)
    expect(takeSwitch(args, '--no-push')).toBe(true)
    expect(args).toEqual(['name'])
  })
})

describe('takeFlag', () => {
  it('removes a flag with its value', () => {
    const args = ['a', '--kind', 'agy', 'b']
    expect(takeFlag(args, '--kind')).toBe('agy')
    expect(args).toEqual(['a', 'b'])
  })
})

describe('peerKind', () => {
  it('parses a kind id, and names the kinds when it cannot', () => {
    expect(peerKind('agy', '--to-kind')).toBe('agy')
    expect(() => peerKind('codex', '--to-kind')).toThrow('--to-kind "codex" is not a kind. Kinds: claude, agy, opencode.')
    expect(() => peerKind(undefined, '--to-kind')).toThrow('--to-kind is missing a kind.')
  })
})
