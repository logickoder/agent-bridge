import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { unlinkBin } from '../../lib/config.js'
import type { InstallContext } from '../types.js'

// Claude joins through a local plugin: the repo is a marketplace (.claude-plugin/marketplace.json) whose
// plugin lives in src/adapters/claude/plugin. A local-path marketplace loads in place, so a rebuild needs
// no reinstall. The channel launcher is opt-in now: `agent-bridge claude`, or an alias for it.

const MARKETPLACE = 'agent-bridge'
const PLUGIN = `agent-bridge@${MARKETPLACE}`
/** Linked by older installs. Removed on install and uninstall. */
const LEGACY_LAUNCHER = 'claude-bridge'

const claudeBin = (ctx: InstallContext): string => ctx.env['AGENT_BRIDGE_CLAUDE_BIN'] ?? 'claude'

/** Runs the claude CLI. A failure becomes a report line, not an exception: agy's setup must still finish. */
function claude(ctx: InstallContext, args: string[], ok: string): string {
  const r = spawnSync(claudeBin(ctx), args, { encoding: 'utf8' })
  if (r.error) return `claude    skipped: ${r.error.message}. Install Claude Code, then rerun \`agent-bridge install\`.`
  if (r.status === 0) return ok
  const why = `${r.stderr}${r.stdout}`.trim().split('\n')[0] ?? `exit ${r.status}`
  return `claude    \`claude ${args.join(' ')}\` failed: ${why}`
}

function removeLegacyLauncher(ctx: InstallContext): string[] {
  const dst = path.join(ctx.binDir, LEGACY_LAUNCHER)
  return unlinkBin(dst, path.join(ctx.repo, 'bin', LEGACY_LAUNCHER)) ? [`removed ${dst}`] : []
}

export function install(ctx: InstallContext): string[] {
  return [
    ...removeLegacyLauncher(ctx),
    claude(ctx, ['plugin', 'marketplace', 'add', ctx.repo], `claude    marketplace ${MARKETPLACE} (${ctx.repo})`),
    claude(ctx, ['plugin', 'install', PLUGIN], `claude    plugin ${PLUGIN}`),
  ]
}

export function uninstall(ctx: InstallContext): string[] {
  return [
    ...removeLegacyLauncher(ctx),
    claude(ctx, ['plugin', 'uninstall', PLUGIN], `removed claude plugin ${PLUGIN}`),
    claude(ctx, ['plugin', 'marketplace', 'remove', MARKETPLACE], `removed claude marketplace ${MARKETPLACE}`),
  ]
}
