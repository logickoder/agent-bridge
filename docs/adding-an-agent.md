# Adding an agent

An adapter answers three questions for its agent.

1. **Wake.** How does a message reach an idle session? Seen so far, in order of preference:
   - push into the live session through a native interface: Claude's inbox socket, agy's `agentapi send-message`, opencode's `ctx.session.prompt` from a plugin;
   - an extension that runs in the session and listens: Claude's plugin monitor;
   - a background command whose exit wakes the agent: agy's `listen`;
   - a hook that injects messages at the next model call: agy's PreInvocation. It only fires when something else starts a turn.
2. **Identity.** Which session is which? An env var the agent sets for commands (`CLAUDE_CODE_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`), a hook field, or a plugin that passes it (opencode).
3. **Knowledge.** How does the agent learn the protocol? A skill or tool when joining takes an action. Do not install anything that loads into sessions not on the bridge without the user asking.

## Steps

1. Add the kind to `PEER_KINDS` in `src/schema.ts`. `src/adapters/index.ts` now fails to compile.
2. Create `src/adapters/<kind>/`. Its `index.ts` exports the `Adapter` (`src/adapters/types.ts`) and loads everything else lazily. Split the rest by concern:
   - `pushEndpoint` and `deliver` for a push path, or a stream command built on `holdListen` for a listening path.
   - `commands`: any listener, stream or hook the agent calls. Names must be unique across adapters.
   - `install` / `uninstall`: the agent's config, written with `src/lib/config.ts`. Touch only our own entries.
   - `joinHint` and `joined`: what the user and agent see.
3. Register it in `ADAPTERS`.
4. Spike the wake live once before building, and log it in [live-tests.md](live-tests.md). A kind without a wake path can still send.
5. Unit tests next to the code, e2e coverage in `test/e2e.test.ts`.

## Next adapters (researched, not built)

- **Codex CLI.** The TUI runs on a local app-server daemon (unless `--no-daemon`): JSON-RPC over a WebSocket on a Unix socket under `/tmp/codex-daemon-<uid>/`. An adapter would `initialize`, find the thread with `thread/loaded/list` and `thread/read`, then `turn/start {threadId, input}` when idle or `turn/steer {threadId, expectedTurnId, input}` mid-turn. Sources: learn.chatgpt.com/docs/app-server, agent-intercom `docs/live-push.md` (MIT), openai/codex#11415. Untested here. Access (OpenAI pricing page, 2026-11-02): the CLI needs ChatGPT Plus ($20/month) or an API key; Free and Go list only the desktop app. Whether the desktop app runs the same daemon is unverified.
- **Gemini CLI.** Hooks only: `AfterAgent` with `decision: "deny"` keeps a turn going, but nothing wakes an idle session.
- **Cursor CLI.** ACP over stdio for headless use only; no live-session path found.
