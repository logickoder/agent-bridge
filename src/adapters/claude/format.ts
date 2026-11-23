import { fenceBody, messageHeader, remoteCaution, replyOr, sendGuide, sendHeredoc } from '../../format.js'
import type { Message } from '../../schema.js'

// Monitor events are single lines, so every message and notice fits on one.

const replyHint = (m: Message): string => replyOr(m, `Reply with ${sendHeredoc(m.to, m.from, 'reply')}.`)

/** One monitor line per message: sender, recipient, the text with newlines escaped, and how to reply. */
export function monitorLine(m: Message): string {
  return [`${messageHeader(m)}, text as JSON: ${JSON.stringify(m.text)}`, replyHint(m), remoteCaution(m)].filter(Boolean).join(' ')
}

/** What the inbox socket delivers. Claude shows it as a message from another session. */
export function socketText(m: Message): string {
  const caution = remoteCaution(m)
  return `${messageHeader(m)}:\n${fenceBody(m.text)}\n\n${replyHint(m)}${caution ? `\n${caution}` : ''}`
}

/** What `join` prints for Claude after the name. */
export const joinedText = (name: string, pushed: boolean): string =>
  [
    pushed
      ? 'Messages from peers arrive in this session directly, as messages from another session.'
      : 'Messages from peers arrive as monitor events from the agent-bridge monitor.',
    `Send with ${sendGuide(name)}. Reply with the command each message shows. \`agent-bridge peers\` lists who is online.`,
  ].join('\n')

export const monitorNotice = (text: string): string => `[agent-bridge] ${text.replace(/\s+/g, ' ').trim()}`
