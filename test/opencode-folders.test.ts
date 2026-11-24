import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { createPlugin, shouldAutoJoinFromFile, type Exec, type Spawn, type Tool } from '../src/adapters/opencode/plugin/agent-bridge.js'

// Real folders and a symlink, so this lives in test/, not next to the unit.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ocfolders-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const proj = path.join(root, 'proj')
const link = path.join(root, 'proj-link')
fs.mkdirSync(proj)
fs.symlinkSync(proj, link)

function homeWith(autoJoin: unknown): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(root, 'home-'))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoJoin }))
  return { AGENT_BRIDGE_HOME: home }
}

describe('opencode plugin folders', () => {
  it('matches an ignore entry that is a symlink to the session folder', () => {
    const env = homeWith({ enabled: true, ignore: [link] })
    expect(shouldAutoJoinFromFile(proj, env)).toBe(false)
    expect(shouldAutoJoinFromFile(link, env)).toBe(false)
    expect(shouldAutoJoinFromFile(path.join(root, 'elsewhere'), env)).toBe(true)
  })

  it('joins a session whose event directory is a symlink to the plugin folder', async () => {
    const execs: string[][] = []
    const exec: Exec = async args => {
      execs.push(args)
      return 'Joined agent-bridge as "proj-opencode".'
    }
    const spawn: Spawn = () => ({ stdout: new PassThrough(), kill: () => {} })
    const tools: Tool[] = []
    const ctx = {
      location: { directory: proj },
      tool: { transform: async (fn: (e: { add: (t: Tool) => void }) => void) => fn({ add: t => tools.push(t) }) },
      session: { prompt: async () => undefined },
      event: {
        subscribe: async function* () {
          yield { type: 'session.created', location: { directory: link }, data: { sessionID: 'ses_link' } }
        },
      },
    }
    await createPlugin({ exec, spawn, shouldAutoJoin: () => true }).setup(ctx)
    await new Promise(r => setTimeout(r, 20))
    expect(execs).toEqual([['join', '--kind', 'opencode']])
  })
})
