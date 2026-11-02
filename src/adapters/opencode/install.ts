import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstallContext } from '../types.js'

// opencode loads every file in ~/.config/opencode/plugins/ at startup. install copies the built plugin there.

const PLUGIN_FILE = 'agent-bridge.js'
const BUILT = path.join('dist', 'adapters', 'opencode', 'plugin', PLUGIN_FILE)

const pluginDst = (ctx: InstallContext): string =>
  path.join(ctx.env['OPENCODE_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'opencode'), 'plugins', PLUGIN_FILE)

export function install(ctx: InstallContext): string[] {
  const dst = pluginDst(ctx)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(path.join(ctx.repo, BUILT), dst)
  return [`opencode  plugin ${dst} (restart opencode to load it)`]
}

export function uninstall(ctx: InstallContext): string[] {
  const dst = pluginDst(ctx)
  if (!fs.existsSync(dst)) return []
  fs.rmSync(dst)
  return [`removed ${dst}`]
}
