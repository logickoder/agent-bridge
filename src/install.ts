import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADAPTERS } from './adapters/index.js'
import type { InstallContext } from './adapters/types.js'
import { linkBin, onPath, unlinkBin } from './lib/config.js'
import { REPO } from './paths.js'

const CLI_REL = path.join('dist', 'cli.js')
const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

const isWritable = (dir: string): boolean => {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function installContext(env: NodeJS.ProcessEnv = process.env): InstallContext {
  const binDir = env['AGENT_BRIDGE_BIN_DIR'] ?? SYSTEM_BIN_DIRS.find(isWritable) ?? path.join(os.homedir(), '.local', 'bin')
  return { binDir, exe: path.join(binDir, 'agent-bridge'), repo: REPO, env }
}

/** Links `agent-bridge` onto PATH, then runs every adapter's install. Idempotent. */
export async function install(ctx: InstallContext): Promise<string[]> {
  const cli = path.join(ctx.repo, CLI_REL)
  if (!fs.existsSync(cli)) throw new Error(`${CLI_REL} is missing. Run \`pnpm build\` first.`)
  // After `npm i -g` the CLI is already on PATH through npm's own link. Replacing that link would let
  // uninstall delete it later while the npm package stays installed.
  const existing = onPath('agent-bridge', ctx.env)
  const lines: string[] = []
  let target = ctx
  if (existing && fs.realpathSync(existing) === fs.realpathSync(cli)) {
    lines.push(`bin       already on PATH: ${existing}`)
    // Adapters write this path into other tools' config, so it must be the one that exists. binDir stays:
    // uninstall gets the same one, and legacy cleanup looks where install linked before.
    target = { ...ctx, exe: existing }
  } else {
    linkBin(ctx.exe, cli)
    lines.push(`bin       ${ctx.exe}`)
    if (existing && path.resolve(existing) !== path.resolve(ctx.exe)) {
      lines.push(`bin       warning: ${existing} comes first on PATH and is another agent-bridge. Remove it, or put ${path.dirname(ctx.exe)} first.`)
    }
  }
  // One adapter after another: they report in a fixed order.
  for (const a of Object.values(ADAPTERS)) lines.push(...(await a.install(target)))
  return lines
}

/** Reverses install. Leaves daemon state (~/.agent-bridge) alone. */
export async function uninstall(ctx: InstallContext): Promise<string[]> {
  const done: string[] = []
  for (const a of Object.values(ADAPTERS)) done.push(...(await a.uninstall(ctx)))
  if (unlinkBin(ctx.exe, path.join(ctx.repo, CLI_REL))) done.push(`removed ${ctx.exe}`)
  return done
}
