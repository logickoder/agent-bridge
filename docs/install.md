# What `install` changes

`agent-bridge install` is idempotent and restarts the daemon. Rerun it after `npm update -g @logickoder/agent-bridge`, after switching Node versions (nvm, fnm: the package folder moves), and after `pnpm build` or editing a skill or plugin in a source checkout. Install copies the Antigravity skill and opencode plugin and registers the package folder with Claude, so those copies go stale otherwise. `uninstall` removes only these entries and keeps daemon state in `~/.agent-bridge`.

| Target | Change |
|---|---|
| `/opt/homebrew/bin` (or `/usr/local/bin`, `~/.local/bin`) | Symlinks `agent-bridge` to `dist/cli.js`, unless an `agent-bridge` from this package is already on PATH (an npm global install). Uninstall removes only a link install made. Also removes a `claude-bridge` link from older installs |
| Claude Code plugins | `claude plugin marketplace add <repo>` and `claude plugin install agent-bridge@agent-bridge` (refreshing any cached copy so updated hooks and skills take effect). The repo is a local marketplace (`.claude-plugin/marketplace.json`); the plugin lives in `src/adapters/claude/plugin/` |
| `~/.gemini/config/mcp_config.json` | Adds the `agent-bridge` server. Other servers untouched |
| `~/.gemini/config/hooks.json` | Adds the `agent-bridge` hook group (`SessionStart`, `PreInvocation`). Other groups untouched |
| `~/.gemini/config/skills/bridge/` | Copies the Antigravity `/bridge` skill from `src/adapters/agy/skill/` |
| `~/.config/opencode/plugins/agent-bridge.js` | Copies the built opencode plugin. Restart opencode to load it |

To pause the Antigravity hook, set `"enabled": false` on the `agent-bridge` group in `hooks.json`.

## Auto-join

Auto-join is off by default. Turn it on once to join live sessions to the local bridge automatically (saved in `~/.agent-bridge/config.json`):

```sh
agent-bridge auto-join on
agent-bridge auto-join ignore /path/to/scratch   # skip noisy folders (exact match)
agent-bridge auto-join off
```

- **Claude Code:** joins silently on `SessionStart` and leaves on `SessionEnd`.
- **opencode:** joins silently on `session.created` and leaves on `session.deleted`.
- **Antigravity:** `SessionStart` prompts `agy` to run `agent-bridge join --kind agy` on its first turn (hooks do not receive the agentapi address or token). Antigravity has no `SessionEnd` hook; the daemon probes its local `ANTIGRAVITY_LS_ADDRESS` port to drop exited CLI sessions. In the IDE or desktop app where one language server serves multiple conversations, a closed conversation stays listed online until that language server exits.
- Auto-join only joins the local bridge. Network sharing (`/bridge share`) stays opt-in per session.

## Environment overrides

| Variable | Overrides |
|---|---|
| `AGENT_BRIDGE_HOME` | Daemon state, default `~/.agent-bridge` |
| `AGENT_BRIDGE_BIN_DIR` | Where the `agent-bridge` link goes |
| `AGENT_BRIDGE_CLAUDE_BIN` | The `claude` CLI install calls |
| `AGENT_BRIDGE_CLOUDFLARED` | The `cloudflared` binary for `net host --tunnel cloudflared` |
| `AGENT_BRIDGE_TUNNEL_GRACE_MS` | How long a trial tunnel outlives the daemon before it stops, default 60000 |
| `AGY_CONFIG_DIR` | Antigravity config, default `~/.gemini/config` |
| `OPENCODE_CONFIG_DIR` | opencode config, default `~/.config/opencode` |

## Networks

Hosting a network needs a tunnel from the internet to the host's machine. Members only connect outward and need nothing.

The daemon's network server always listens on a socket file, `~/.agent-bridge/net/http.sock`, that only you can reach. A tunnel gets to it one of two ways:

- **Through a port (the default).** A small keeper process holds `127.0.0.1:<port>` (default 7787) and relays to the socket. The keeper outlives daemon restarts and installs, so the port is never free while your tunnel points at it, and while the daemon is down members get "host offline" and retry. It holds the port until `net stop --yes` or `uninstall`. After a reboot nothing holds the port until the daemon first starts (any `agent-bridge` command or agent session starts it). If your tunnel starts at boot, use the socket instead, or start your tunnel after the bridge.
- **Straight to the socket (`--socket`).** No port at all, so there is nothing to take, not even after a reboot. With the daemon down the socket is gone and the tunnel reports an error. Needs a tunnel or proxy that can forward to a Unix socket.

### A lasting network

Use a tunnel with a fixed address, and pass it with `--public-url`:

- **Cloudflare named tunnel.** `cloudflared tunnel create agent-bridge` and route a hostname to it. With `--socket`, point its ingress at `service: unix:<home>/net/http.sock` (tested live, 2026-11-21). Without, point it at `http://127.0.0.1:7787`. Then `agent-bridge net host --public-url https://<that hostname> [--socket]`.
- **A reverse proxy you already run.** Caddy `reverse_proxy unix/<home>/net/http.sock`, or nginx `proxy_pass http://unix:<home>/net/http.sock:;`, with `--socket`.
- **Tailscale Funnel.** `tailscale funnel 7787`, then `agent-bridge net host --public-url https://<machine>.<tailnet>.ts.net`. Whether Funnel can forward to a socket file: UNKNOWN, so use the port.
- **ngrok with a reserved domain.** `ngrok http --domain=<domain> 7787`, then `agent-bridge net host --public-url https://<domain>`. Socket support: UNKNOWN, so use the port.

`--port` picks another local port. `--name` names the network and `--handle` your member name.

### Try it

`agent-bridge net host --tunnel cloudflared` starts a free Cloudflare quick tunnel (needs `cloudflared` on PATH, or set `AGENT_BRIDGE_CLOUDFLARED`). It is a trial: Cloudflare makes no uptime promise, and the address changes whenever the tunnel restarts (a reboot, a crash). The keeper runs cloudflared and holds its port, so a daemon restart or `agent-bridge install` keeps the address. Quick tunnels cannot forward to a socket file (tested: cloudflared reads `unix:` as a host name there), so trial mode always uses a port. The keeper stops the tunnel once the daemon has been gone for a minute, and frees the port only after cloudflared has exited. When the address does change, connected members follow, and the host's `agent-bridge net status` prints the signed `net set-url` line for members who were offline.

### Files

Network state lives in `~/.agent-bridge/net/`, every file mode 0600: `identity.json` (this daemon's keys), `link.json` (membership, pins), `outbox/` (messages waiting for the host), and on the host `host.json`, `server.json`, `mailbox/`, the socket `http.sock`, and the keeper's `keeper.json` and `keeper.log`. `net leave` and `net stop` delete the network's files and keep the identity. Messages still in the outbox are dropped, and each sender is told.
