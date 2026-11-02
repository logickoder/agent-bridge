import path from 'node:path'
import { linkBin, unlinkBin } from '../../lib/config.js'
import type { InstallContext } from '../types.js'

// Claude needs no config change: claude-bridge passes the server per launch. Only the launcher goes on PATH.

const LAUNCHER = 'claude-bridge'

const launcherLink = (ctx: InstallContext): { dst: string; src: string } => ({
  dst: path.join(ctx.binDir, LAUNCHER),
  src: path.join(ctx.repo, 'bin', LAUNCHER),
})

export function install(ctx: InstallContext): string[] {
  const { dst, src } = launcherLink(ctx)
  linkBin(dst, src)
  return [`bin       ${dst}`]
}

export function uninstall(ctx: InstallContext): string[] {
  const { dst, src } = launcherLink(ctx)
  return unlinkBin(dst, src) ? [`removed ${dst}`] : []
}
