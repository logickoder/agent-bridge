import fs from 'node:fs'

/** Name every client sees for this server. Also the key in client configs. */
export const SERVER_NAME = 'agent-bridge'

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
export const VERSION: string = pkg.version
