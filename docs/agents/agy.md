# agy (Antigravity CLI)

Tested on agy 1.4.12, macOS. Code: `src/adapters/agy/`.

## Receiving

- **Direct delivery** (default). `/bridge` runs `join`, which registers agy's agentapi endpoint: the address and CSRF token from `run_command`'s environment, kept in daemon memory only. The daemon delivers each message with `agy agentapi send-message`, which wakes an idle agy. The daemon runs only an absolute path to an executable named `agy`. `push.ts`
- **Listener** (fallback). A background `agent-bridge listen --as <name>` exits when a message arrives, which wakes agy; agy re-arms it after each message. `listen.ts`
- **Hook** (fallback). A PreInvocation hook drains queued messages into the next turn, 1.5s cap, `{}` on any failure. Messages leave the queue only after the hook has printed them. `hook.ts`

Identity: `ANTIGRAVITY_CONVERSATION_ID`, set in `run_command`'s environment and sent to hooks as `conversationId`. The hook delivers only to the session a name is bound to, since `hooks.json` is global.

## Recovering direct delivery

Endpoints live in daemon memory, and hooks never see the token (finding 9). After a daemon restart, the hook asks agy once to run `join` again. After agy restarts, even with `--continue` on the same conversation, the old endpoint is dead (finding 10): the push fails, the message stays queued, and the hook delivers it at agy's next turn.

## Findings

1. **MCP push cannot wake agy.** A stdio server sent `notifications/message`, `resources/updated`, `resources/list_changed` and `tools/list_changed`; agy only re-fetched `tools/list`. Its docs describe MCP as pull-only.
2. **agy sends `server/discover`** (MCP 2025-11-25) before `initialize`. The server answers `-32601`.
3. **Stop hook `continue` works but stalls agy.** Hooks run synchronously, and `maxStopHookContinuations` caps it.
4. **agy wakes when a background `run_command` finishes.** A FIFO write woke an idle agy (MANGO-7). The listener's wake.
5. **PreToolUse `{}` means deny.** A hook returning `{}` blocked `echo ok`: "tool call denied by pre-tool hook". `decision` is required; there is no neutral value. Never ship a PreToolUse hook that does not mean to gate every matched call.
6. **`ANTIGRAVITY_CONVERSATION_ID` is in `run_command`'s environment**, the same id hooks receive as `conversationId`.
7. **`hooks.json` is global.** `~/.gemini/config/hooks.json` applies to the CLI, desktop app and IDE.
8. **`agy agentapi send-message <conversation> <text>` wakes an idle agy.** Undocumented. It needs `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` (sent as `x-codeium-csrf-token`), which agy sets in `run_command`'s environment along with `ANTIGRAVITY_AGENTAPI_EXE`. Spike, 2026-11-02: a detached delayed `send-message` woke agy 20s after its turn ended. The reply shows in the transcript; the injected message does not, so delivered text asks agy to name the sender. agent-intercom uses the same call.
9. **Hooks do not get the address or token.** A probe hook saw only `ANTIGRAVITY_CONVERSATION_ID`, so only `join` can register direct delivery.
10. **The endpoint dies when agy restarts.** After `agy --continue` (same conversation id) `send-message` failed with exit 1.
