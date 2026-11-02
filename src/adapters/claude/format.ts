import type { Message } from '../../schema.js'

// Monitor events are single lines, so every message and notice fits on one.

const sendCommand = (as: string, to: string): string => `agent-bridge send --as ${as} ${to} "<reply>"`

/** One monitor line per message: sender, recipient, the text with newlines escaped, and how to reply. */
export function monitorLine(m: Message): string {
  return `[agent-bridge] Message from ${m.from} to ${m.to} (id ${m.id}): ${JSON.stringify(m.text)} Reply with: ${sendCommand(m.to, m.from)}`
}

/** What `join` prints for Claude after the name. */
export const joinedText = (name: string): string =>
  [
    'Messages from peers arrive as monitor events from the agent-bridge monitor.',
    `Send or reply with: ${sendCommand(name, '<peer>')}. See peers with \`agent-bridge status\`.`,
  ].join('\n')

export const monitorNotice = (text: string): string => `[agent-bridge] ${text.replace(/\s+/g, ' ').trim()}`
