import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stands in for the tunnel: a TCP proxy that forwards to the host's port and records every byte both ways.
 * Its port is known before the host starts, so it can be the host's public URL; the target is set later.
 * It runs in a child process because the tests call the CLI synchronously, which blocks this one.
 */
export interface Proxy {
  port: number
  /** A port, or a socket file path. */
  setTarget: (target: number | string) => Promise<void>
  /** Flips one character in the next sealed RPC frame in that direction. Resolves once it has. */
  tamper: (dir: 'up' | 'down') => Promise<void>
  /** Everything that crossed, both directions. */
  recorded: () => Buffer
  close: () => Promise<void>
}

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxy-child.mjs')

export async function startProxy(): Promise<Proxy> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-proxy-'))
  const record = path.join(dir, 'wire.bin')
  fs.writeFileSync(record, '')
  const child = spawn(process.execPath, [CHILD, record], { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  const waiters: (() => void)[] = []
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString()
    for (const w of waiters.splice(0)) w()
  })
  const lineMatching = async (re: RegExp): Promise<RegExpExecArray> => {
    for (;;) {
      const m = re.exec(out)
      if (m) {
        out = out.slice(m.index + m[0].length)
        return m
      }
      await new Promise<void>(r => waiters.push(r))
    }
  }
  const port = Number((await lineMatching(/port (\d+)\n/))[1])
  let closing: Promise<void> | undefined
  return {
    port,
    setTarget: async p => {
      child.stdin.write(`target ${p}\n`)
      await lineMatching(/ok target\n/)
    },
    tamper: async dir => {
      child.stdin.write(`tamper ${dir}\n`)
      await lineMatching(new RegExp(`tampered ${dir}\n`))
    },
    recorded: () => fs.readFileSync(record),
    close: () => {
      closing ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(r => child.once('exit', () => r()))
          child.stdin.end()
          await exited
        }
        fs.rmSync(dir, { recursive: true, force: true })
      })()
      return closing
    },
  }
}
