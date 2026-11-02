import { resolveName } from '../../client/index.js'
import type { Identity } from '../../names.js'
import { listenCommand, sendHint } from './format.js'

/** What /bridge runs first: settle this session's name and tell agy how to use it. */
export async function join(identity: Identity, session: string | undefined): Promise<string> {
  const name = await resolveName(identity, 'agy', session)
  return [`Joined agent-bridge as "${name}".`, `Listen: run \`${listenCommand(name)}\` with run_command in the background.`, sendHint(name)].join('\n')
}
