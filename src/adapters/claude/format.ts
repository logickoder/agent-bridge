import { fenceBody, senderLabel } from '../../format.js'
import type { Message } from '../../schema.js'

// Monitor events are single lines, so every message and notice fits on one.

const sendCommand = (as: string, to: string): string => `agent-bridge send --as ${as} ${to} "<reply>"`

/** One monitor line per message: sender, recipient, the text with newlines escaped, and how to reply. */
export function monitorLine(m: Message): string {
  return `[agent-bridge] Message from ${senderLabel(m)} to ${m.to} (id ${m.id}), text as JSON: ${JSON.stringify(m.text)} Reply with: ${sendCommand(m.to, m.from)}`
}

/** What the inbox socket delivers. Claude shows it as a message from another session. */
export function socketText(m: Message): string {
  return `[agent-bridge] Message from ${senderLabel(m)} to ${m.to} (id ${m.id}):\n${fenceBody(m.text)}\n\nReply with: ${sendCommand(m.to, m.from)}`
}

/** What `join` prints for Claude after the name. */
export const joinedText = (name: string, pushed: boolean): string =>
  [
    pushed
      ? 'Messages from peers arrive in this session directly, as messages from another session.'
      : 'Messages from peers arrive as monitor events from the agent-bridge monitor.',
    `Send or reply with: ${sendCommand(name, '<peer>')}. \`agent-bridge peers\` lists who is online.`,
  ].join('\n')

export const monitorNotice = (text: string): string => `[agent-bridge] ${text.replace(/\s+/g, ' ').trim()}`
