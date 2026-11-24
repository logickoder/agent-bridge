import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const name = pkg.name.replace(/^@[^/]+\//, '')
const version = pkg.version

const pluginPath = 'src/adapters/claude/plugin/.claude-plugin/plugin.json'
const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'))
if (plugin.version !== version) {
  plugin.version = version
  fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`)
}

const identityPath = 'src/mcp/identity.ts'
const nextIdentity = [
  '// Generated from package.json by scripts/sync-version.mjs. Do not edit by hand.',
  '/** Name every client sees for this server. Also the key in client configs. */',
  `export const SERVER_NAME = ${JSON.stringify(name)}`,
  `export const VERSION = ${JSON.stringify(version)}`,
  '',
].join('\n')
const prevIdentity = fs.existsSync(identityPath) ? fs.readFileSync(identityPath, 'utf8') : ''
if (nextIdentity !== prevIdentity) {
  fs.writeFileSync(identityPath, nextIdentity)
}
