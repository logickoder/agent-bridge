# Live test log

Every wake path was proven in real sessions before it became a default. Newest last.

- **2026-11-01.** MCP push spike, Stop hook spike, FIFO wake (MANGO-7).
- **2026-11-02.** PreToolUse `{}` blocked `echo ok` in Antigravity. Hook disabled at once, PreToolUse removed.
- **2026-11-02.** Antigravity env var confirmed. A background `agent-bridge listen` bound the daemon to the conversation. A shell send woke idle Antigravity; it replied PAPAYA-9 and re-armed the listener on its own.
- **2026-11-02.** Prototype to TypeScript rebuild: three prototype daemons found running at once. `PAPAYA-9` was no longer queued before the upgrade; what consumed it is unknown.
- **2026-11-02.** Auto names: `/bridge` in Antigravity joined as `agent-bridge-agy`. A launcher-started Claude session in the same folder showed as `agent-bridge-claude`. Claude printed "no MCP server configured with that name" at launch, yet received channel pushes.
- **2026-11-02.** Both default paths of the time, both ways: Antigravity direct delivery and the Claude plugin monitor. Idle sessions woke for each message and replied. No launch flags, no banner.
- **2026-11-02.** Rejoin hint: after `agent-bridge install` restarted the daemon, Antigravity's next turn showed the injected hint, ran `join`, and was online again. The hint is visible in Antigravity's transcript as a user-style message.
- **2026-11-02.** Claude receive modes. Socket mode: Antigravity's message, posted by the daemon with no auth line, woke an idle prompting Claude session as a message from another session. Monitor mode still worked in a second session.
- **2026-11-02.** opencode: asked to join the bridge, it called `bridge_join` and joined as `agent-bridge-opencode`. Antigravity messaged it twice; idle opencode woke with the fenced message (sender checked) and replied with `bridge_send`, live.
- **2026-11-02.** Claude bypass mode (`claude --dangerously-skip-permissions`, `/bridge`). A socket message was held: "Held peer message, from an unidentified session [verified pid <daemon>] ... this session bypasses prompts", with Deny / Deliver. The daemon had already acked it, so a denied or expired message is lost while the sender saw "Delivered live". Led to the bypass guard hook.
- **2026-11-02.** Antigravity resume: joined with direct delivery, quit, `agy --continue`. The push failed (exit 1), the endpoint was dropped and the message stayed queued. Typing in Antigravity delivered it through the hook; Antigravity replied and rejoined. Fixed after: "live" for an unfinished push, the rejoin hint used up earlier in the daemon run, listener advice in push mode, a reply hint pointing at `shell`, and the raw session id in the daemon log.
