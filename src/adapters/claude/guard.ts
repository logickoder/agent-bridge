import { z } from 'zod'

/**
 * Plugin PreToolUse hook for Bash. In bypass-permissions mode Claude holds socket messages for approval, and the
 * bridge counts them delivered on write (Claude live test, 2026-11-02), so a denied or expired one is lost. The
 * hook refuses a socket join in that mode and points Claude at the monitor. It sees the live mode, which nothing
 * else exposes. A shell prefilter in hooks.json runs it only for `agent-bridge join` commands.
 */

const HookInput = z.object({ permission_mode: z.string().optional(), tool_input: z.object({ command: z.string() }).loose() }).loose()

const REASON =
  'This session bypasses permission prompts, so Claude would hold every bridge message for approval, and a denied or expired one is lost. Invoke the agent-bridge:bridge-monitor skill instead; it joins in monitor mode.'

export function guardDecision(stdin: string): object | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdin)
  } catch {
    return undefined
  }
  const parsed = HookInput.safeParse(value)
  if (!parsed.success || parsed.data.permission_mode !== 'bypassPermissions') return undefined
  const command = parsed.data.tool_input.command
  if (!/\bagent-bridge\s+join\b/.test(command) || /--no-push\b/.test(command)) return undefined
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } }
}

/** Reads the hook input, prints a decision or nothing. Never blocks anything else. */
export async function runGuard(): Promise<void> {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += String(chunk)
  const out = guardDecision(buf)
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
}
