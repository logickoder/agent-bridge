import { request } from '../../client/index.js'
import { autoBase } from '../../names.js'
import { listenCommand } from './format.js'

/** What /bridge runs first: settle this session's name and tell agy how to use it. */
export async function join(name: string | undefined, session: string | undefined, cwd: string): Promise<string> {
  const chosen = name ?? (await claimed(session, cwd))
  return [
    `Joined agent-bridge as "${chosen}".`,
    `Listen: run \`${listenCommand(chosen)}\` with run_command in the background.`,
    `Send: call the send tool with as "${chosen}".`,
  ].join('\n')
}

async function claimed(session: string | undefined, cwd: string): Promise<string> {
  if (!session) {
    throw new Error('no agy session id. join without a name needs ANTIGRAVITY_CONVERSATION_ID. Run it from agy, or pass a name.')
  }
  const r = await request({ op: 'claim', base: autoBase(cwd, 'agy'), kind: 'agy', session }, 'claimed')
  return r.name
}
