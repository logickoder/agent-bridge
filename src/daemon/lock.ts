import fs from 'node:fs'
import { errnoCode } from '../lib/errors.js'

/** A lock file without a pid older than this is debris from a crash, not a daemon starting up. */
const UNREADABLE_STALE_MS = 5000

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return errnoCode(err) === 'EPERM'
  }
}

/** Creates `file` holding `content`, or fails if it exists. The file never exists half-written. */
function create(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false
    throw err
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** The holder's pid, `undefined` if the file is gone, `null` if it holds no pid. */
function holder(file: string): { pid: number | null; ageMs: number } | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10)
    return { pid: Number.isInteger(pid) ? pid : null, ageMs: Date.now() - fs.statSync(file).mtimeMs }
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Takes the single-instance lock. Concurrent clients can each spawn a daemon; only one may own the
 * socket, or the others keep stale state and orphan their listeners.
 */
export function acquireLock(file: string, pid: number): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(file, String(pid))) return true
    const h = holder(file)
    if (!h) continue
    if (h.pid === null ? h.ageMs < UNREADABLE_STALE_MS : isAlive(h.pid)) return false
    // Stale. Move it aside, then check we moved the stale one and not a lock taken in the meantime.
    const aside = `${file}.stale-${pid}`
    try {
      fs.renameSync(file, aside)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue
      throw err
    }
    const moved = fs.readFileSync(aside, 'utf8')
    fs.rmSync(aside, { force: true })
    if (moved !== (h.pid === null ? '' : String(h.pid))) {
      // A fresh lock: restore it and back off. Its owner is starting.
      create(file, moved)
      return false
    }
  }
  return false
}
