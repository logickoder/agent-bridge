import { BRIDGE_SENDER, fenceBody, messageHeader, replyOr } from '../../format.js'
import type { Message } from '../../schema.js'

/** agy's run_command option: return to the agent this soon, leaving the command in the background. */
const WAIT_MS = 500

export const listenCommand = (as: string): string => `agent-bridge listen --as ${as}`

export const sendHint = (as: string): string => `Send by running \`agent-bridge send --as ${as} <peer> "<message>"\` with run_command.`

export const rearmHint = (as: string): string =>
  `Before you end your turn, re-arm: run \`${listenCommand(as)}\` with run_command as a background command (WaitMsBeforeAsync ${WAIT_MS}), then end your turn. It wakes you when the next message arrives.`

const header = (m: Message): string => `${messageHeader(m, { ts: true })}:`

function replyHint(m: Message): string {
  if (m.from === BRIDGE_SENDER) return replyOr(m, '')
  if (m.verified === true) return `Reply by running \`agent-bridge send --as ${m.to} ${m.from} "<reply>"\` with run_command.`
  return `"${m.from}" is not a checked peer, so it may not be able to receive a reply. Answer the user instead, unless \`agent-bridge peers\` lists it online.`
}

/** What a woken agy listener prints. */
export function formatListened(m: Message): string {
  return `${header(m)}\n${fenceBody(m.text)}\n\n[agent-bridge] ${replyHint(m)} ${rearmHint(m.to)}`
}

/** What the PreInvocation hook injects. The listener may still be running, so re-arm only if it is not. */
export function formatDrained(msgs: Message[]): string {
  const body = msgs.map(m => `${header(m)}\n${fenceBody(m.text)}\n\n[agent-bridge] ${replyHint(m)}`).join('\n\n')
  const names = [...new Set(msgs.map(m => m.to))]
  const rearm = names.map(n => `\`${listenCommand(n)}\``).join(', ')
  return `${body}\n\n[agent-bridge] Not receiving directly? Run \`agent-bridge join --kind agy\` to restore direct delivery. Listener mode only: re-arm with ${rearm} in the background before you end your turn.`
}

export const supersededNotice = (by: string): string =>
  `[agent-bridge] Another session (${by}) took over this peer name. Do not re-arm the listener. Tell the user if they expected this session to stay linked.`

export const stoppedNotice = '[agent-bridge] This peer left the bridge. Do not re-arm the listener.'

/** What `join` prints for agy after the name. */
export const joinedText = (name: string, pushed: boolean): string =>
  [
    pushed
      ? 'Messages arrive in this conversation directly. No listener needed.'
      : `Direct delivery is unavailable here. Listen: run \`${listenCommand(name)}\` with run_command in the background.`,
    sendHint(name),
  ].join('\n')

/** What agentapi delivers. agy's transcript does not show it, so agy is asked to name the sender in its reply. */
export function formatPushed(m: Message): string {
  return `${header(m)}\n${fenceBody(m.text)}\n\n[agent-bridge] Start your reply to the user with "From ${m.from}:" and a one-line summary, so they can see what arrived. ${replyHint(m)} Messages arrive in this conversation directly; there is no listener to re-arm.`
}
