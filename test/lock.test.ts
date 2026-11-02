import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { acquireLock } from '../src/daemon/lock.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lock-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let n = 0
const lockFile = (): string => path.join(dir, `daemon-${++n}.lock`)
const DEAD_PID = 2 ** 22 + 7

describe('acquireLock', () => {
  it('takes a free lock and writes the pid in one step', () => {
    const file = lockFile()
    expect(acquireLock(file, 4242)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('4242')
    expect(fs.readdirSync(dir).filter(f => f.startsWith(path.basename(file)))).toEqual([path.basename(file)])
  })

  it('refuses a lock held by a live process', () => {
    const file = lockFile()
    fs.writeFileSync(file, String(process.pid))
    expect(acquireLock(file, 4242)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid))
  })

  it('refuses an empty lock instead of treating it as stale', () => {
    // An older build created the file before writing the pid. Deleting it then let two daemons run.
    const file = lockFile()
    fs.writeFileSync(file, '')
    expect(acquireLock(file, 4242)).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('takes over a lock whose holder is dead', () => {
    const file = lockFile()
    fs.writeFileSync(file, String(DEAD_PID))
    expect(acquireLock(file, 4242)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('4242')
  })
})
