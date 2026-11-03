# What `install` changes

`agent-bridge install` is idempotent and restarts the daemon. Rerun it after `npm update -g @logickoder/agent-bridge`, after switching Node versions (nvm, fnm: the package folder moves), and after `pnpm build` or editing a skill or plugin in a source checkout. Install copies the Antigravity skill and opencode plugin and registers the package folder with Claude, so those copies go stale otherwise. `uninstall` removes only these entries and keeps daemon state in `~/.agent-bridge`.

| Target | Change |
|---|---|
| `/opt/homebrew/bin` (or `/usr/local/bin`, `~/.local/bin`) | Symlinks `agent-bridge` to `dist/cli.js`, unless an `agent-bridge` from this package is already on PATH (an npm global install). Uninstall removes only a link install made. Also removes a `claude-bridge` link from older installs |
| Claude Code plugins | `claude plugin marketplace add <repo>` and `claude plugin install agent-bridge@agent-bridge`. The repo is a local marketplace (`.claude-plugin/marketplace.json`); the plugin lives in `src/adapters/claude/plugin/` and loads in place |
| `~/.gemini/config/mcp_config.json` | Adds the `agent-bridge` server. Other servers untouched |
| `~/.gemini/config/hooks.json` | Adds the `agent-bridge` hook group (PreInvocation). Other groups untouched |
| `~/.gemini/config/skills/bridge/` | Copies the Antigravity `/bridge` skill from `src/adapters/agy/skill/` |
| `~/.config/opencode/plugins/agent-bridge.js` | Copies the built opencode plugin. Restart opencode to load it |

To pause the Antigravity hook, set `"enabled": false` on the `agent-bridge` group in `hooks.json`.

## Environment overrides

| Variable | Overrides |
|---|---|
| `AGENT_BRIDGE_HOME` | Daemon state, default `~/.agent-bridge` |
| `AGENT_BRIDGE_BIN_DIR` | Where the `agent-bridge` link goes |
| `AGENT_BRIDGE_CLAUDE_BIN` | The `claude` CLI install calls |
| `AGY_CONFIG_DIR` | Antigravity config, default `~/.gemini/config` |
| `OPENCODE_CONFIG_DIR` | opencode config, default `~/.config/opencode` |
