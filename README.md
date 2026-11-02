# agent-bridge

Live messaging between agent CLI sessions, as named peers. Claude Code and agy (Antigravity CLI) today. No polling, no headless calls, no tmux. agy never stalls.

## Quick start

```sh
cd ~/projects/agent-bridge
pnpm install && pnpm build
node dist/cli.js install          # once per machine
```

Then:

```sh
claude-bridge                     # Claude session, auto name <folder>-claude
claude-bridge --as reviewer       # or pick a name
```

In agy, type `/bridge` (auto name `<folder>-agy`) or `/bridge planner`. Ask any session to message another by name. `/bridge off` in agy leaves. `agent-bridge uninstall` removes everything.

Requires Node 22+ and pnpm.

## How it works

```
Claude Code  <-- channel push ----  mcp claude (PEER=lead)        \
             --- send / peers --->                                 \
                                                                    daemon: Unix socket, disk queues,
agy          --- send / peers --->  mcp agy (`as` per call)        /         peers + bindings (~/.agent-bridge)
             <-- `agent-bridge listen --as planner` exits           /
             <-- PreInvocation hook (fallback)                     /
```

Every peer has a name, a kind (`claude` or `agy`) and, once it listens, a bound session.

- **Sending** is the same everywhere: the `send` MCP tool (`to`, `text`, and `as` on agy). `peers` lists who is on the bridge.
- **Waking** depends on the agent kind. Each kind implements one `Adapter` (`src/adapters/types.ts`): its MCP server, wake path, identity, extra commands and install. Nothing outside `src/adapters/` branches on kind.

| Kind | Wake | Identity |
|---|---|---|
| `claude` | Channel push into the live session (`notifications/claude/channel`) | `CLAUDE_CODE_SESSION_ID`, which Claude sets for MCP servers. `claude-bridge` passes the name (`--as`) or the project folder to the server |
| `agy` | A background `agent-bridge listen` exits when a message arrives, which wakes agy. A PreInvocation hook injects queued messages as a fallback | `ANTIGRAVITY_CONVERSATION_ID`, set by agy in `run_command`'s environment and sent to hooks as `conversationId` |

### Delivery rules

- One message in flight per peer. It leaves the queue only on ack. A killed listener or a daemon restart loses nothing. Delivery is at least once.
- A waiting listener reconnects after a daemon restart, a dropped socket or a slow start, with backoff up to 5s.
- The agy hook removes messages only after it has printed them. If it hits its time cap first, they stay queued. A failed ack shows them again next turn: a duplicate, never a loss.
- `send` reports "Delivered live" only when the message went out at once. One queued behind a message in flight reports "Queued".
- One daemon at a time, enforced by a lock file. Clients start it on demand.

### Names

- **Auto names, the way Claude names sessions.** Without a name, a session gets `<folder>-<kind>`, e.g. `bankstract-claude` and `bankstract-agy`. The daemon assigns it on `claim`, so two sessions starting at once never collide.
- **If the name cannot be claimed** (daemon down at launch), the Claude server still starts, send-only, and its instructions say why.
- **Never reused while held.** A new session gets the lowest free `-2`, `-3`, even when the holder is offline. The same session, including a resumed one, always gets the same name.
- **Pruned when idle.** A peer nobody listens on is dropped after 24 hours without a listen, ack or drain, or after 7 days if messages are queued (they are dropped too, and the daemon log says so). Pruning runs when a name is claimed, never at daemon startup, so a restart does not drop sessions that have not reconnected yet.
- **Auto names stay with their session.** Another session cannot `listen` on one; it gets an error pointing to `join`. After `/bridge off`, the same session rejoining gets its old name back.
- **Explicit names are roles.** `claude-bridge --as reviewer` or `/bridge planner` take the name, superseding any other session that held it.
- **Finding your name.** Claude: the MCP instructions say "You are peer ...", and `peers` marks it "you". agy: `agent-bridge join` prints it. Any agent shell: `agent-bridge whoami`. (In Claude, the session id can change during a long session, so `whoami` there can miss; ask Claude instead. If Claude ever stops setting `CLAUDE_CODE_SESSION_ID`, the server keys on its pid, and each server restart gets a new name.)
- **Names change across restarts.** A send to a peer that is not listening says who is, so the sender can redirect.

### Binding

- A peer name binds to the newest session that listens with a session id. The previous session's listener wakes with "took over" and does not re-arm.
- Listeners without a session id (run from a plain shell) work only while the name is unbound.
- The agy hook delivers only to the session a peer is bound to. `~/.gemini/config/hooks.json` is global, so this keeps other agy sessions from taking messages.
- `agent-bridge leave <name>` (what `/bridge off` runs) unbinds the name and ends its listeners with a "do not re-arm" notice.
- A name belongs to one kind. A Claude peer and an agy peer cannot share one.

### Why `claude-bridge`

Claude Code accepts channel pushes only in a session launched with `--dangerously-load-development-channels server:agent-bridge`. It asks you to confirm at every launch. Declining exits Claude, so a session that declined never subscribes and never takes messages. `claude-bridge` adds that flag plus `--mcp-config`, so only that session loads the server.

Do not register the server at user scope. Claude does not tell a server whether channels are on. Every session and every `claude mcp get` health check would subscribe, ack messages and drop them. Without `AGENT_BRIDGE_PEER`, the server only sends and never consumes.

## What `install` changes

| Target | Change |
|---|---|
| `/opt/homebrew/bin` (or `/usr/local/bin`, `~/.local/bin`) | Symlinks `agent-bridge` to `dist/cli.js` and `claude-bridge` to `bin/claude-bridge` |
| `~/.gemini/config/mcp_config.json` | Adds the `agent-bridge` server. Other servers untouched |
| `~/.gemini/config/hooks.json` | Adds the `agent-bridge` hook group (PreInvocation). Other groups untouched |
| `~/.gemini/config/skills/bridge/` | Copies the `/bridge` skill from `src/adapters/agy/skill/` |

`install` is idempotent and restarts the daemon. Rerun it after `pnpm build` or after editing the skill. `uninstall` removes only these entries and keeps state in `~/.agent-bridge`.

To pause the agy hook, set `"enabled": false` on the `agent-bridge` group in `hooks.json`.

Environment overrides: `AGENT_BRIDGE_HOME` (daemon state), `AGY_CONFIG_DIR`, `AGENT_BRIDGE_BIN_DIR`.

## Commands

| Command | Does |
|---|---|
| `agent-bridge install` / `uninstall` | Set up or remove everything above |
| `agent-bridge status` | Peers, kinds, bound sessions, online, queued |
| `agent-bridge whoami` | This session's peer name, from the agent's session id |
| `agent-bridge send [--as me] <to> <text>` | Send from the shell (sender `shell` by default) |
| `agent-bridge leave <name>` | Unbind a peer and stop its listeners |
| `agent-bridge restart` | Stop the daemon. The next client starts it |
| `claude-bridge [--as name] [claude args]` | Launch Claude Code on the bridge |
| `agent-bridge join [name]` | agy: settle this session's name (auto by default) and print it |
| `agent-bridge listen --as <name>` | agy: wait for one message, print it, exit |
| `agent-bridge mcp <kind>` | MCP server for one agent kind (`claude`, `agy`) |
| `agent-bridge agy-hook` | agy PreInvocation hook |
| `agent-bridge daemon` | Hub process |

## Development

```sh
pnpm typecheck     # tsc, strict
pnpm test          # unit tests (src/**/*.test.ts): pure, no I/O
pnpm test:e2e      # build, then end-to-end against dist/cli.js with an isolated daemon
pnpm check         # all three: the gate before calling work done
```

Layout and conventions: `AGENTS.md`. Design history, findings and rejected approaches: `docs/design.md`.

## Limits

- Adapters exist for Claude Code and agy only. `docs/design.md` covers adding another.
- Claude asks to confirm development channels at every `claude-bridge` launch.
- Open questions are listed in `docs/design.md`.
