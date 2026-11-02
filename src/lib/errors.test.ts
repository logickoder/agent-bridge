import { describe, expect, it } from 'vitest'
import { errnoCode, isDaemonDown, toError } from './errors.js'

const withCode = (code: string): Error => Object.assign(new Error(code), { code })

describe('errnoCode', () => {
  it('reads a string code and ignores anything else', () => {
    expect(errnoCode(withCode('ENOENT'))).toBe('ENOENT')
    expect(errnoCode(new Error('plain'))).toBeUndefined()
    expect(errnoCode('ENOENT')).toBeUndefined()
  })
})

describe('isDaemonDown', () => {
  it('is true only for a missing or refusing socket', () => {
    expect(isDaemonDown(withCode('ENOENT'))).toBe(true)
    expect(isDaemonDown(withCode('ECONNREFUSED'))).toBe(true)
    expect(isDaemonDown(withCode('EACCES'))).toBe(false)
  })
})

describe('toError', () => {
  it('keeps errors and wraps everything else', () => {
    const err = new Error('x')
    expect(toError(err)).toBe(err)
    expect(toError('boom').message).toBe('boom')
  })
})
