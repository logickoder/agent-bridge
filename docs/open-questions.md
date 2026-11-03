# Open questions

## Open

- Can the user type to Antigravity while its listener runs?
- Does Antigravity re-arm its listener reliably over many turns? (Seen once.)
- Does a background `run_command` time out and kill a listener left waiting for hours?
- Two Antigravity sessions under different names at once, live.
- Does `claude --resume` keep `CLAUDE_CODE_SESSION_ID`, and so the auto name?
- Does a PreToolUse hook's deny apply inside Claude's bypass-permissions mode? The bypass guard depends on it.

## Answered

- **Does `/bridge` reach the Antigravity skill as a slash command?** Yes (live, 2026-11-02).
- **Is the working directory the project folder in each agent?** Yes: each got `<folder>-<kind>` (live, 2026-11-02).
- **Does the PreInvocation fallback fire live?** Yes: it delivered a queued message after Antigravity resumed (live, 2026-11-02).
- **Does Antigravity's hook get the agentapi address and token?** No. Only `ANTIGRAVITY_CONVERSATION_ID` (probe hook, 2026-11-02).
- **Does agentapi survive Antigravity restarting and resuming the conversation?** No. The endpoint fails; the hook and `join` recover (live, 2026-11-02).
- **Antigravity to Claude through a live Claude session?** Yes, through the monitor and the socket (live, 2026-11-02).
