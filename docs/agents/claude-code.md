# Claude Code

Tested on Claude Code 2.1.316, macOS. Code: `src/adapters/claude/`.

## Receiving: pick one

| Mode | How | How a message arrives |
|---|---|---|
| **Socket** (default) | `/bridge` (Claude may list it as `/agent-bridge:bridge`) | `join` registers the session's inbox socket, `CLAUDE_CODE_MESSAGING_SOCKET`. The daemon posts each message there; Claude shows it as a message from another session and an idle session wakes. `socket.ts` |
| **Monitor** | `/agent-bridge:bridge-monitor` | The plugin monitor, `agent-bridge monitor`, prints one line per message; Claude delivers each as a monitor event that wakes an idle session. `monitor.ts` |
| **Channel** | launch with `agent-bridge claude [--as name]` | A channel push into the session. `channel/` |

Identity: `CLAUDE_CODE_SESSION_ID`, which Claude sets for Bash, monitors and MCP servers.

## Bypass-permissions mode

A session started with `--dangerously-skip-permissions` holds every socket message for approval, as Claude does for any message from another session. The bridge counts a held message as delivered, so one you deny, or leave for 5 minutes, is lost. The plugin's PreToolUse hook (`agent-bridge claude-guard`) therefore refuses a socket join in that mode and tells Claude to use the monitor. Hooks are the only place Claude exposes the live permission mode. Not caught: switching into bypass mode after joining.

## Channels (opt-in)

Channels need a launch flag, `--dangerously-load-development-channels server:agent-bridge`, and Claude prints a development-channel notice at every launch. No setting can enable them (Claude Code docs, 2026-11-02).

```sh
agent-bridge claude [--as name] [claude args]    # launch Claude with the channel
alias cb='agent-bridge claude'                    # if you use it often
```

Claude also prints "server:agent-bridge · no MCP server configured with that name" at launch, yet receives: the server comes from `--mcp-config` and seems to register after the check.

Do not register the channel server at user scope. Claude does not tell a server whether channels are on. Without `AGENT_BRIDGE_PEER` or `AGENT_BRIDGE_FOLDER`, the server only sends and never consumes.

## Findings

1. **Channels.** A server declaring `capabilities.experimental['claude/channel']` can send `notifications/claude/channel` with `{ content, meta }`. It arrives in the live session as a `<channel>` turn.
2. **Non-plugin channels need `--dangerously-load-development-channels server:<name>`.** Claude confirms it at launch.
3. **A channel server cannot tell whether channels are on.** A user-scope server would run in every session and in `claude mcp get` health checks, and consume messages nobody sees. Hence the launcher, which sets `AGENT_BRIDGE_PEER` or `AGENT_BRIDGE_FOLDER`.
4. **A plugin monitor wakes an idle session.** Spike, 2026-11-02: a line appended to a tailed file arrived as "Monitor event: ..." and started a turn.
5. **Monitors get the session.** The monitor process had `CLAUDE_CODE_SESSION_ID`, the project folder as its working directory, and `CLAUDE_CODE_MESSAGING_SOCKET`.
6. **`when: "on-skill-invoke:<plugin>:<skill>"` needs the qualified skill name.** The bare skill name never started the monitor.
7. **Claude treats monitor output as data.** With no skill saying otherwise it declined to act on a monitor line. Once the user had invoked a skill describing peer messages, it answered.
8. **The inbox socket wakes an idle session.** Spike, 2026-11-02: one line, `{"type":"user","message":{"role":"user","content":"..."},"from":"agent-bridge:spike"}`, written to `$CLAUDE_CODE_MESSAGING_SOCKET` with no auth line, started a turn showing "Another Claude session sent a message". The socket path is documented; the line format is not, and comes from agent-intercom (`docs/live-push.md`, MIT). The daemon sends no auth line, so Claude's inbound controls apply: delivered in prompting sessions, held in bypass-permission ones.
9. **No env var exposes the permission mode.** Hook input does: `permission_mode` (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`).
10. **`CLAUDE_CODE_SESSION_ID` can differ between processes of one long-lived session.** So `whoami` from Claude's shell can miss; ask Claude instead. Without the variable, the channel server keys on its pid and each restart gets a new name.
