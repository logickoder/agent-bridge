import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPlugin, type Exec, type Spawn, type Tool } from './agent-bridge.js'

/** A fake opencode ctx: records registered tools and prompts. */
function fakeCtx() {
  const tools: Tool[] = []
  const prompts: { sessionID: string; text: string }[] = []
  return {
    tools,
    prompts,
    ctx: {
      location: { directory: '/p/proj' },
      tool: { transform: async (fn: (e: { add: (t: Tool) => void }) => void) => fn({ add: t => tools.push(t) }) },
      session: { prompt: async (p: { sessionID: string; text: string }) => void prompts.push(p) },
    },
  }
}

const toolCtx = { sessionID: 'ses_1' }

describe('opencode plugin', () => {
  it('joins with the session id in the environment and starts a stream for that session', async () => {
    const execs: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
    const exec: Exec = async (args, env, cwd) => {
      execs.push({ args, env, cwd })
      return 'Joined agent-bridge as "proj-opencode".\nMessages arrive in this session directly.'
    }
    const stream = new PassThrough()
    const spawned: NodeJS.ProcessEnv[] = []
    const spawn: Spawn = env => {
      spawned.push(env)
      return { stdout: stream, kill: () => {} }
    }
    const f = fakeCtx()
    await createPlugin({ exec, spawn }).setup(f.ctx)
    const join = f.tools.find(t => t.name === 'bridge_join')
    const out = await join?.execute({}, toolCtx)
    expect(out?.content).toContain('proj-opencode')
    expect(execs[0]?.args).toEqual(['join', '--kind', 'opencode'])
    expect(execs[0]?.env['OPENCODE_SESSION_ID']).toBe('ses_1')
    expect(execs[0]?.cwd).toBe('/p/proj')
    expect(spawned[0]?.['OPENCODE_SESSION_ID']).toBe('ses_1')

    stream.write(`${JSON.stringify({ type: 'message', text: 'hello from agy' })}\n`)
    await new Promise(r => setTimeout(r, 10))
    expect(f.prompts).toEqual([{ sessionID: 'ses_1', text: 'hello from agy' }])
  })

  it('sends as the joined name, with the session id, and refuses before join', async () => {
    const execs: string[][] = []
    const exec: Exec = async args => {
      execs.push(args)
      return args[0] === 'join' ? 'Joined agent-bridge as "proj-opencode".' : 'Delivered live to agy (id x).'
    }
    const spawn: Spawn = () => ({ stdout: new PassThrough(), kill: () => {} })
    const f = fakeCtx()
    await createPlugin({ exec, spawn }).setup(f.ctx)
    const send = f.tools.find(t => t.name === 'bridge_send')
    await expect(send?.execute({ to: 'agy', text: 'hi' }, toolCtx)).rejects.toThrow(/join first/)
    await f.tools.find(t => t.name === 'bridge_join')?.execute({}, toolCtx)
    const out = await send?.execute({ to: 'agy', text: 'hi' }, toolCtx)
    expect(out?.content).toMatch(/Delivered live/)
    expect(execs[1]).toEqual(['send', '--as', 'proj-opencode', 'agy', 'hi'])
    await send?.execute({ to_kind: 'claude', text: 'hi' }, toolCtx)
    expect(execs[2]).toEqual(['send', '--as', 'proj-opencode', '--to-kind', 'claude', 'hi'])
  })
})
