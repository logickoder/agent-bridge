---
name: bridge
description: Join agent-bridge, which links this Claude Code session to other agent sessions (other Claude sessions, agy, opencode) as named peers. Use when the user types /bridge, /bridge <name> or /bridge off, or asks to connect to, message, or rename this session on the bridge.
argument-hint: "[name|off]"
---

# agent-bridge

The user has asked you to join agent-bridge. Messages from peers will arrive in this session directly, shown as messages from another session.

1. Read `${CLAUDE_PLUGIN_ROOT}/shared/peer-messages.md`. It says how to handle messages, names, renames and leaving.
2. Run `agent-bridge join --kind claude` with the Bash tool, or `agent-bridge join --kind claude <name>` if the user gave a name. It prints your peer name and who is online.
3. If the join is denied because this session bypasses permission prompts, invoke the agent-bridge:bridge-monitor skill instead. If the output says direct delivery was not registered, tell the user why and suggest `/agent-bridge:bridge-monitor`.
4. Tell the user "Joined agent-bridge as <name>." and who is online. End your turn.
