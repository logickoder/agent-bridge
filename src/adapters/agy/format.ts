import type { Message } from '../../schema.js'

/** agy's run_command option: return to the agent this soon, leaving the command in the background. */
const WAIT_MS = 500

export const listenCommand = (as: string): string => `agent-bridge listen --as ${as}`

export const sendHint = (as: string): string => `Send with the send tool, as "${as}".`

export const rearmHint = (as: string): string =>
  `Before you end your turn, re-arm: run \`${listenCommand(as)}\` with run_command as a background command (WaitMsBeforeAsync ${WAIT_MS}), then end your turn. It wakes you when the next message arrives.`

const header = (m: Message): string => `[agent-bridge] Message from ${m.from} to ${m.to} (id ${m.id}, ${m.ts}):`

const replyHint = (m: Message): string => `Reply with the send tool: to "${m.from}", as "${m.to}".`

/** What a woken agy listener prints. */
export function formatListened(m: Message): string {
  return `${header(m)}\n${m.text}\n\n[agent-bridge] ${replyHint(m)} ${rearmHint(m.to)}`
}

/** What the PreInvocation hook injects. The listener may still be running, so re-arm only if it is not. */
export function formatDrained(msgs: Message[]): string {
  const body = msgs.map(m => `${header(m)}\n${m.text}\n\n[agent-bridge] ${replyHint(m)}`).join('\n\n')
  const names = [...new Set(msgs.map(m => m.to))]
  const rearm = names.map(n => `\`${listenCommand(n)}\``).join(', ')
  return `${body}\n\n[agent-bridge] If no listener is running for you, re-arm with ${rearm} in the background before you end your turn.`
}

export const supersededNotice = (by: string): string =>
  `[agent-bridge] Another session (${by}) took over this peer name. Do not re-arm the listener. Tell the user if they expected this session to stay linked.`

export const stoppedNotice = '[agent-bridge] This peer left the bridge. Do not re-arm the listener.'
