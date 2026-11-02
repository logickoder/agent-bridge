# agent-bridge

Live messaging between agent CLI sessions, as named peers. Claude Code, agy (Antigravity CLI) and opencode today. No polling, no headless calls, no tmux. agy never stalls.

## Quick start

```sh
cd ~/projects/agent-bridge
pnpm install && pnpm build
node dist/cli.js install          # once per machine
```

Then join from each session: `/bridge` in Claude Code or agy, or ask opencode to join the bridge. Without a name you get `<folder>-<kind>` (e.g. `myapp-claude`, `myapp-agy`, `myapp-opencode`); `/bridge planner` picks one. Ask any session to message another by name. `/bridge <new name>` renames, `/bridge off` leaves. `agent-bridge uninstall` removes everything.

Claude Code needs no special launch: `/bridge` comes from the agent-bridge plugin that `install` registers. Claude may list it as `/agent-bridge:bridge`. Messages then arrive through the session's inbox socket. Prefer the monitor? Use `/agent-bridge:bridge-monitor`. A session in bypass-permissions mode holds socket messages for your approval, as Claude does for any message from another session. The bridge counts a held message as delivered, so one you deny, or leave for 5 minutes, is lost. So in bypass mode the plugin's PreToolUse hook refuses a socket join and points Claude at the monitor (`/agent-bridge:bridge-monitor`). Hooks are the only place Claude exposes the live permission mode.

Requires Node 22+ and pnpm.

## How it works

```
Claude Code  <-- plugin monitor: `agent-bridge monitor`, one line per message \
             --- `agent-bridge send` -------------------------------------->  \
                                                                    daemon: Unix socket, disk queues,
agy          --- send / peers --->  mcp agy (`as` per call)        /         peers + bindings (~/.agent-bridge)
             <-- `agent-bridge listen --as planner` exits           /
             <-- PreInvocation hook (fallback)                     /
```

Every peer has a name, a kind (`claude` or `agy`) and, once it listens, a bound session.

- **Sending**: `agent-bridge send --as <me> <to> <text>`, or the `send` MCP tool (`to`, `text`, and `as` on agy). `peers` or `agent-bridge status` lists who is on the bridge.
- **Waking** depends on the agent kind. Each kind implements one `Adapter` (`src/adapters/types.ts`): its MCP server, wake path, identity, extra commands and install. Nothing outside `src/adapters/` branches on kind.

| Kind | Wake | Identity |
|---|---|---|
| `claude` | Pick one. **Socket (default):** `/bridge` runs `join`, which registers the session's inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`); the daemon posts each message there and Claude shows it as a message from another session, waking an idle session. **Monitor:** `/agent-bridge:bridge-monitor` starts the plugin monitor, one line per message as a monitor event. **Channel:** launch with `agent-bridge claude` (see below) | `CLAUDE_CODE_SESSION_ID`, which Claude sets for Bash, monitors and MCP servers |
| `agy` | Default: `join` registers agy's agentapi endpoint (address and CSRF token from `run_command`'s environment, kept in daemon memory only) and the daemon delivers each message with `agy agentapi send-message`, which wakes an idle agy. Fallbacks: a background `agent-bridge listen` whose exit wakes agy, and a PreInvocation hook that injects queued messages | `ANTIGRAVITY_CONVERSATION_ID`, set by agy in `run_command`'s environment and sent to hooks as `conversationId` |
| `opencode` | The agent-bridge plugin (installed to `~/.config/opencode/plugins/`) adds `bridge_join`, `bridge_send` and `bridge_leave` tools. After a join it runs `agent-bridge opencode-stream` for the session and prompts each message into it with `ctx.session.prompt`, which wakes an idle session | The tool call's `sessionID`, passed to the CLI as `OPENCODE_SESSION_ID` (opencode exports none) |

### Delivery rules

- One message in flight per peer. It leaves the queue only on ack. A killed listener or a daemon restart loses nothing. Delivery is at least once.
- A waiting listener reconnects after a daemon restart, a dropped socket or a slow start, with backoff up to 5s.
- The agy hook removes messages only after it has printed them. If it hits its time cap first, they stay queued. A failed ack shows them again next turn: a duplicate, never a loss.
- `send` reports "Delivered live" only when the message went out at once. One queued behind a message in flight reports "Queued".
- **Sender check.** A send from inside an agent session carries the session id, and the daemon accepts the sender name only if that session holds it. Sends without a session (plain shell, agy's MCP tool) arrive marked `(unverified)`. What this is and is not: it stops mislabeled and casual spoofing, such as an agent told to "send as lead". It is not a security boundary. Every session runs as your OS user, so any of your processes that finds another session's id can send as it. `status` shows a tag instead of raw session ids so they are not one copy away. Message text is fenced between `--- message text` and `--- end of message text ---`, and lines inside that look like bridge metadata are escaped.
- One daemon at a time, enforced by a lock file. Clients start it on demand.
- A push endpoint (agy) is acked only when `send-message` succeeds. A failure keeps the message queued, drops the endpoint, and the fallbacks take over. Endpoints live in daemon memory. After a daemon restart, agy's hook asks it once to run `join` again, which restores direct delivery at its next turn. After an agy restart, run `/bridge` again. The daemon runs only an absolute path to an executable named `agy`.

### Names

- **Auto names, the way Claude names sessions.** Without a name, a session gets `<folder>-<kind>`, e.g. `bankstract-claude` and `bankstract-agy`. The daemon assigns it on `claim`, so two sessions starting at once never collide.
- **If the name cannot be claimed** (daemon down at launch), the Claude server still starts, send-only, and its instructions say why.
- **Never reused while held.** A new session gets the lowest free `-2`, `-3`, even when the holder is offline. The same session, including a resumed one, always gets the same name.
- **Pruned when idle.** A peer nobody listens on is dropped after 24 hours without a listen, ack or drain, or after 7 days if messages are queued (they are dropped too, and the daemon log says so). Pruning runs when a name is claimed, never at daemon startup, so a restart does not drop sessions that have not reconnected yet.
- **Auto names stay with their session.** Another session cannot `listen` on one; it gets an error pointing to `join`. After `/bridge off`, the same session rejoining gets its old name back.
- **Explicit names are roles.** `/bridge planner` (or `agent-bridge claude --as planner`) takes the name if its holder is offline. If another session is online with it, `join` refuses: pick another name, or `join --take planner` to take it over. The old session is told: its listener, monitor or stream reports the takeover, and a push-mode session gets one last message saying so.
- **Renaming.** `/bridge <new name>` in a session that already has a name renames it. A free new name is renamed in place: queue, binding and running listener carry over. An existing name takes the session's listener, and the old name is released.
- **The monitor waits for `join`.** It starts when `/bridge` runs, possibly before `join` has bound a name. It listens by session id and the daemon attaches it as soon as `join` binds one.
- **Finding your name.** `agent-bridge join` prints it, and every message repeats it. Any agent shell: `agent-bridge whoami`. (In Claude, the session id can change during a long session, so `whoami` there can miss; ask Claude instead. If Claude ever stops setting `CLAUDE_CODE_SESSION_ID`, the server keys on its pid, and each server restart gets a new name.)
- **Names change across restarts.** A send to a peer that is not listening says who is, so the sender can redirect.

### Binding

- A peer name binds to the newest session that listens with a session id. The previous session's listener wakes with "took over" and does not re-arm.
- Listeners without a session id (run from a plain shell) work only while the name is unbound.
- The agy hook delivers only to the session a peer is bound to. `~/.gemini/config/hooks.json` is global, so this keeps other agy sessions from taking messages.
- `agent-bridge leave <name>` (what `/bridge off` runs) unbinds the name and ends its listeners with a "do not re-arm" notice.
- A name belongs to one kind. A Claude peer and an agy peer cannot share one.

### Channels (opt-in)

A Claude Code channel pushes messages straight into the session, as an alternative to the socket and the monitor. It needs a launch flag, `--dangerously-load-development-channels server:agent-bridge`, and Claude prints a development-channel notice at every launch. No setting can enable it (checked in the Claude Code docs, 2026-11-02).

```sh
agent-bridge claude [--as name] [claude args]    # launch Claude with the channel
alias cb='agent-bridge claude'                    # if you use it often
```

It also prints "server:agent-bridge · no MCP server configured with that name" at launch, yet receives: the server comes from `--mcp-config` and seems to register after the check. Use one receive path per session. A second one is refused, and `join` says so.

Do not register the channel server at user scope. Claude does not tell a server whether channels are on. Without `AGENT_BRIDGE_PEER` or `AGENT_BRIDGE_FOLDER`, the server only sends and never consumes.

## What `install` changes

| Target | Change |
|---|---|
| `/opt/homebrew/bin` (or `/usr/local/bin`, `~/.local/bin`) | Symlinks `agent-bridge` to `dist/cli.js`. Removes a `claude-bridge` link from older installs |
| Claude Code plugins | `claude plugin marketplace add <repo>` and `claude plugin install agent-bridge@agent-bridge`. The repo is a local marketplace (`.claude-plugin/marketplace.json`); the plugin lives in `src/adapters/claude/plugin/` and loads in place |
| `~/.gemini/config/mcp_config.json` | Adds the `agent-bridge` server. Other servers untouched |
| `~/.gemini/config/hooks.json` | Adds the `agent-bridge` hook group (PreInvocation). Other groups untouched |
| `~/.config/opencode/plugins/agent-bridge.js` | Copies the built opencode plugin. Restart opencode to load it |
| `~/.gemini/config/skills/bridge/` | Copies the `/bridge` skill from `src/adapters/agy/skill/` |

`install` is idempotent and restarts the daemon. Rerun it after `pnpm build` or after editing the skill. `uninstall` removes only these entries and keeps state in `~/.agent-bridge`.

To pause the agy hook, set `"enabled": false` on the `agent-bridge` group in `hooks.json`.

Environment overrides: `AGENT_BRIDGE_HOME` (daemon state), `AGY_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `AGENT_BRIDGE_BIN_DIR`, `AGENT_BRIDGE_CLAUDE_BIN` (the `claude` CLI install calls).

## Commands

| Command | Does |
|---|---|
| `agent-bridge install` / `uninstall` | Set up or remove everything above |
| `agent-bridge status` | Peers, kinds, bound sessions, online, queued |
| `agent-bridge peers [--all]` | Who is online. Offline peers are only counted; `--all` lists everyone with queue sizes. `join` prints the online list too |
| `agent-bridge whoami` | This session's peer name, from the agent's session id |
| `agent-bridge send [--as me] <to> <text>` | Send from the shell (sender `shell` by default) |
| `agent-bridge leave <name>` | Unbind a peer and stop its listeners |
| `agent-bridge restart` | Stop the daemon. The next client starts it |
| `agent-bridge join [name] [--kind k] [--no-push]` | Bind this session's name (auto by default; a name renames), register direct delivery, and print it. `--kind` is needed when the shell has both agents' session ids. `--no-push` receives by listening (monitor mode, agy listener) |
| `agent-bridge claude-guard` | Claude plugin PreToolUse hook: refuses a socket join in bypass-permissions mode |
| `agent-bridge monitor` | Claude plugin monitor: one line per message for this session |
| `agent-bridge claude [--as name] [claude args]` | Launch Claude Code with a channel instead of the monitor |
| `agent-bridge listen --as <name>` | agy: wait for one message, print it, exit |
| `agent-bridge opencode-stream` | opencode plugin stream: one JSON line per message for the session in `OPENCODE_SESSION_ID` |
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

- Adapters exist for Claude Code, agy and opencode (v2 plugin API, beta). `docs/design.md` covers adding another.
- The opt-in channel path shows a development-channel notice at every `agent-bridge claude` launch. The default monitor path has none.
- Open questions are listed in `docs/design.md`.
