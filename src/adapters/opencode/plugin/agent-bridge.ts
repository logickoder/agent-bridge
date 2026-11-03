// agent-bridge plugin for opencode v2 (docs/agents/opencode.md, findings 1 to 3). install copies the built file to
// ~/.config/opencode/plugins/agent-bridge.js, so it must stay standalone: node built-ins only, no local imports.
//
// Tools: bridge_join, bridge_send, bridge_leave. Each runs the agent-bridge CLI with OPENCODE_SESSION_ID set,
// since opencode exports no session id to processes. After a join, an `agent-bridge opencode-stream` child prints
// one JSON line per message for that session, and the plugin hands each to ctx.session.prompt, which wakes an
// idle session.

import { execFile, spawn as spawnChild } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

const CLI = process.env['AGENT_BRIDGE_BIN'] ?? 'agent-bridge'
const SESSION_ENV = 'OPENCODE_SESSION_ID'

export interface ToolResult {
  content: string
}

export interface Tool {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: { sessionID: string }) => Promise<ToolResult>
}

/** The slice of opencode's plugin ctx this plugin uses. */
export interface Ctx {
  location: { directory: string }
  tool: { transform: (fn: (editor: { add: (tool: Tool) => void }) => void) => Promise<unknown> }
  session: { prompt: (p: { sessionID: string; text: string }) => Promise<unknown> }
}

/** Runs the CLI to completion and returns stdout. Rejects with stderr on failure. */
export type Exec = (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>
/** Starts a long-running CLI process. */
export type Spawn = (env: NodeJS.ProcessEnv, cwd: string) => { stdout: Readable; kill: () => void }

const realExec: Exec = (args, env, cwd) =>
  new Promise((resolve, reject) => {
    execFile(CLI, args, { env, cwd, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message))
      else resolve(String(stdout).trim())
    })
  })

const realSpawn: Spawn = (env, cwd) => {
  // stdin stays open as a pipe: when opencode exits, it closes and the stream exits too.
  const child = spawnChild(CLI, ['opencode-stream'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
  return { stdout: child.stdout, kill: () => child.kill() }
}

const StreamLine = (value: unknown): { type: string; text: string } | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const type: unknown = Reflect.get(value, 'type')
  const text: unknown = Reflect.get(value, 'text')
  return typeof type === 'string' && typeof text === 'string' ? { type, text } : undefined
}

export function createPlugin(deps: { exec: Exec; spawn: Spawn }) {
  return {
    id: 'agent-bridge',
    async setup(ctx: Ctx) {
      const names = new Map<string, string>()
      const streams = new Map<string, () => void>()
      const envFor = (sessionID: string): NodeJS.ProcessEnv => ({ ...process.env, [SESSION_ENV]: sessionID })
      const cwd = ctx.location.directory

      const startStream = (sessionID: string): void => {
        if (streams.has(sessionID)) return
        const child = deps.spawn(envFor(sessionID), cwd)
        streams.set(sessionID, child.kill)
        createInterface({ input: child.stdout }).on('line', line => {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          const event = StreamLine(parsed)
          if (!event) return
          if (event.type !== 'message') streams.delete(sessionID)
          void ctx.session.prompt({ sessionID, text: event.text }).catch(() => {})
        })
      }

      const requireName = (sessionID: string): string => {
        const name = names.get(sessionID)
        if (!name) throw new Error('not on agent-bridge yet. Call bridge_join first.')
        return name
      }

      await ctx.tool.transform(editor => {
        editor.add({
          name: 'bridge_join',
          description:
            'Join agent-bridge, which links this opencode session to other agent sessions (Claude Code, agy, other opencode sessions) as named peers. Call when the user asks to join the bridge, optionally with a name. Calling it again with a new name renames this session.',
          input: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Peer name. Omit for the automatic <folder>-opencode.' },
              take: { type: 'boolean', description: 'Take the name even if another session is online with it. Only when the user asks.' },
            },
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const args = ['join', '--kind', 'opencode', ...(input['take'] === true ? ['--take'] : []), ...(typeof input['name'] === 'string' ? [input['name']] : [])]
            const out = await deps.exec(args, envFor(context.sessionID), cwd)
            const name = /Joined agent-bridge as "([^"]+)"/.exec(out)?.[1]
            if (name) names.set(context.sessionID, name)
            startStream(context.sessionID)
            return { content: out }
          },
        })
        editor.add({
          name: 'bridge_send',
          description:
            'Send a message to another peer on agent-bridge. Use bridge_join first. Run `agent-bridge status` to see peer names. Pass to, or to_kind to reach the one online peer of that kind in this folder.',
          input: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Peer name' },
              to_kind: { type: 'string', description: 'Instead of to: an agent kind (claude, agy, opencode)' },
              text: { type: 'string', description: 'The message' },
            },
            required: ['text'],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const name = requireName(context.sessionID)
            if ((input['to'] === undefined) === (input['to_kind'] === undefined)) throw new Error('pass one of "to" or "to_kind". Name a peer, or a kind to reach the one in this folder.')
            const target = input['to_kind'] !== undefined ? ['--to-kind', String(input['to_kind'])] : [String(input['to'])]
            const out = await deps.exec(['send', '--as', name, ...target, String(input['text'])], envFor(context.sessionID), cwd)
            return { content: out }
          },
        })
        editor.add({
          name: 'bridge_leave',
          description: 'Leave agent-bridge. Call when the user asks to leave or disconnect from the bridge.',
          input: { type: 'object', properties: {}, additionalProperties: false },
          execute: async (_input, context) => {
            const name = requireName(context.sessionID)
            const out = await deps.exec(['leave', name], envFor(context.sessionID), cwd)
            streams.get(context.sessionID)?.()
            streams.delete(context.sessionID)
            names.delete(context.sessionID)
            return { content: out }
          },
        })
      })

      return () => {
        for (const kill of streams.values()) kill()
      }
    },
  }
}

export default createPlugin({ exec: realExec, spawn: realSpawn })
