import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { JsonObject, readObject, writeObject } from '../../lib/config.js'
import type { InstallContext } from '../types.js'

/** Key of our entry in agy's mcp_config.json and of our group in hooks.json. */
const GROUP = 'agent-bridge'
/** agy's own timeout for the hook command. The hook caps itself at 1.5s first. */
const HOOK_TIMEOUT_S = 3

const McpConfig = z.object({ mcpServers: JsonObject.optional() }).loose()

const files = (ctx: InstallContext) => {
  const dir = ctx.env['AGY_CONFIG_DIR'] ?? path.join(os.homedir(), '.gemini', 'config')
  return {
    mcp: path.join(dir, 'mcp_config.json'),
    hooks: path.join(dir, 'hooks.json'),
    skillSrc: path.join(ctx.repo, 'src', 'adapters', 'agy', 'skill'),
    skillDst: path.join(dir, 'skills', 'bridge'),
  }
}

/** MCP entry, PreInvocation hook group and /bridge skill. Other entries in agy's config stay untouched. */
export function install(ctx: InstallContext): string[] {
  const f = files(ctx)
  const mcp = readObject(f.mcp, McpConfig) ?? {}
  writeObject(f.mcp, { ...mcp, mcpServers: { ...mcp.mcpServers, [GROUP]: { command: ctx.exe, args: ['mcp', 'agy'], disabled: false } } })

  const hooks = readObject(f.hooks, JsonObject) ?? {}
  hooks[GROUP] = { enabled: true, PreInvocation: [{ type: 'command', command: `${ctx.exe} agy-hook`, timeout: HOOK_TIMEOUT_S }] }
  writeObject(f.hooks, hooks)

  fs.rmSync(f.skillDst, { recursive: true, force: true })
  fs.cpSync(f.skillSrc, f.skillDst, { recursive: true })
  return [`agy mcp   ${f.mcp}`, `agy hook  ${f.hooks}`, `agy skill ${f.skillDst}`]
}

export function uninstall(ctx: InstallContext): string[] {
  const f = files(ctx)
  const done: string[] = []
  const mcp = readObject(f.mcp, McpConfig)
  if (mcp?.mcpServers?.[GROUP]) {
    const { [GROUP]: _removed, ...rest } = mcp.mcpServers
    writeObject(f.mcp, { ...mcp, mcpServers: rest })
    done.push(`removed agy mcp entry from ${f.mcp}`)
  }

  const hooks = readObject(f.hooks, JsonObject)
  if (hooks?.[GROUP]) {
    const { [GROUP]: _removed, ...rest } = hooks
    if (Object.keys(rest).length) writeObject(f.hooks, rest)
    else fs.unlinkSync(f.hooks)
    done.push(`removed agy hook group from ${f.hooks}`)
  }

  if (fs.existsSync(f.skillDst)) {
    fs.rmSync(f.skillDst, { recursive: true })
    done.push(`removed ${f.skillDst}`)
  }
  return done
}
