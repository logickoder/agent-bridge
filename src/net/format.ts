import { verifyHint } from '../format.js'
import { levelCovers, type NetInfo, type NetMemberInfo } from '../schema.js'

/** Text for `net` commands. Pure. Fingerprint guidance is worded the same everywhere: see docs/concepts.md. */

/** Shown wherever a quick tunnel is in use: host, status, invite. */
export const TRIAL_NOTE =
  'Trial tunnel. Its address changes whenever it restarts (reboot, crash), and members are cut off until they get the new one. For a lasting network, use a named tunnel and `--public-url`.'

/** Why an agent session cannot raise a member's level, and what the user runs instead. */
export const raiseRefused = (handle: string, level: string): string =>
  `An agent session cannot raise a member's level. It lets another user's agent act here without asking you, so only you set it. Run \`agent-bridge net allow ${handle} ${level}\` in your own terminal.`

/** Why an agent session cannot accept a changed key, by trust or verify. A swapped key looks exactly like a changed one. */
export const keyChoiceRefused = (handle: string, command: string): string =>
  `An agent session cannot accept ${handle}'s changed key. A key swapped by someone in the middle looks exactly like a new one, so only you decide. Check the code with ${handle} yourself, then run \`agent-bridge net ${command}\` in your own terminal.`

/**
 * Why an agent session cannot mark a key verified. A host in the middle can hand out its own key from the start,
 * and `net status` prints that key's code, so an agent could copy it into `net verify`.
 */
export const verifyRefused = (handle: string): string =>
  `An agent session cannot mark ${handle}'s key verified. Someone in the middle can hand out their own key, and \`net status\` prints its code, so only you decide. Check the code with ${handle} yourself, then run \`agent-bridge net verify ${handle} <code>\` in your own terminal.`

export const VERIFY_HINT =
  'Compare fingerprints with each member over a call or a separate chat, never through the bridge, then run `agent-bridge net verify <handle> <code>`. Until you do, the host could read your messages.'

function memberLine(m: NetMemberInfo): string {
  if (m.self) return `  ${m.handle} (you${m.host ? ', host' : ''})`
  const role = m.host ? ', host' : ''
  if (m.changed) return `  ${m.handle}${role}  KEY CHANGED. Nothing goes either way. ${verifyHint(m.handle)} Or accept it unverified: \`agent-bridge net trust ${m.handle}\`.`
  const state = m.verified ? 'verified' : 'unverified'
  const until = m.allowUntil !== undefined ? ` until ${m.allowUntil}` : ''
  const scope = m.allowAgents !== undefined ? ` (${m.allowAgents.join(', ')} only)` : ''
  return `  ${m.handle}${role}  ${m.online ? 'online' : 'offline'}  ${state}  allow: ${m.allow}${scope}${until}  ${m.fingerprint}`
}

/** What each member may do with one shared agent, as the share reply states it, so the agent need not guess. */
export function formatAgentLevels(members: NetMemberInfo[], agent: string): string {
  const others = members.filter(m => !m.self)
  if (!others.length) return ''
  const raised = others.filter(m => m.allow !== 'ask' && levelCovers(m.allowAgents, agent))
  if (!raised.length) return 'Every member is at level ask here: their requests need your user.'
  const list = raised.map(m => `${m.handle}: ${m.allow}${m.allowUntil !== undefined ? ` until ${m.allowUntil}` : ''}`).join(', ')
  return `Levels for ${agent}: ${list}. Every other member is at ask.`
}

function formatMembers(members: NetMemberInfo[]): string {
  return members.length ? ['Members:', ...members.map(memberLine)].join('\n') : 'Members: none yet.'
}

export function formatStatus(info: NetInfo): string {
  if (info.role === 'none') return 'Not in a network. Host one with `agent-bridge net host`, or join with `agent-bridge net connect <invite>`.'
  const name = info.network ?? ''
  if (info.state === 'revoked') return `The host removed this daemon from network "${name}". Run \`agent-bridge net leave\` to clear it, then join again with a new invite.`
  const lines = [
    info.role === 'host'
      ? `Network "${name}", hosted here as ${info.handle ?? ''}. Address: ${info.url ?? ''}. ${info.socket !== undefined ? `Socket: ${info.socket}` : `Local port: ${info.port ?? 'not held'}`}.`
      : `Network "${name}", member ${info.handle ?? ''}. Host: ${info.url ?? ''}. ${info.connected ? 'Connected.' : 'Not connected; retrying.'}`,
    `Your fingerprint: ${info.fingerprint ?? ''}`,
    formatMembers(info.members),
  ]
  if (info.trial) lines.push(TRIAL_NOTE)
  if (info.members.some(m => !m.self && !m.verified)) lines.push(VERIFY_HINT)
  if (info.urlUpdate) lines.push(`If a member was offline when the address changed, send them this line: agent-bridge net set-url ${info.urlUpdate}`)
  return lines.join('\n')
}
