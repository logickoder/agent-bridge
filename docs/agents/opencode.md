# opencode

Command and kind id: `opencode`, so peers are named like `myapp-opencode`. Tested on opencode 2.2.5 (v2 plugin API, beta), macOS. Code: `src/adapters/opencode/`.

## Receiving

The agent-bridge plugin, copied to `~/.config/opencode/plugins/agent-bridge.js`, adds three tools: `bridge_join`, `bridge_send` and `bridge_leave`. Ask opencode to join the bridge and it calls `bridge_join`. After a join, the plugin runs `agent-bridge opencode-stream` for the session and prompts each message into it with `ctx.session.prompt`, which wakes an idle session. The stream exits when opencode does.

Identity: the tool call's `sessionID`, which the plugin passes to the CLI as `OPENCODE_SESSION_ID`, since opencode exports no session id to processes. The plugin is a standalone file (node built-ins only); naming, queues and acks stay in the CLI.

## Findings

1. **The plugin API is v2, not what the v1 docs describe.** A v1-style `export const X = async (input) => {...}` fails: "Plugin must export a default definition with an id and an effect or setup function." A plain `.js` file exporting `{ id, setup }` loads with no package import.
2. **What a plugin gets.** `setup(ctx)`: `ctx.session` (`prompt`, `synthetic`, `interrupt`, `list`, ...), `ctx.tool.transform` to register tools, `ctx.command`, `ctx.event`, `ctx.shell`, and `ctx.location.directory`. A tool's execute context has `sessionID`, `messageID`, `agent`. No `OPENCODE*` env vars.
3. **`ctx.session.prompt({ sessionID, text })` wakes an idle session.** Spike, 2026-11-02: a prompt scheduled 20s after the turn ended showed in the TUI and was answered. Source: opencode.ai/v2/docs/build/plugins/server.
