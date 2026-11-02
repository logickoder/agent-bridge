# Design record

Goal: agent CLI sessions talk to each other like Claude's own session-to-session messaging. No polling, no headless calls, no tmux. agy must never stall.

The first prototype linked one Claude session to one agy session, as a single JS file. The current build is agnostic: named peers, any number of sessions, agent-specific code isolated in adapters, strict TypeScript.

Target: agy (Antigravity CLI) 1.4.12, Claude Code 2.1.316, macOS.

## Findings

### agy

1. **MCP push cannot wake agy.** A stdio MCP server sent 7 cycles of `notifications/message`, `resources/updated`, `resources/list_changed` and `tools/list_changed`. agy only re-fetched `tools/list` (9 times). It never subscribed to or read resources, and nothing reached model context. agy's own docs describe MCP as pull-only.
2. **agy sends `server/discover`** (MCP 2025-11-25) before `initialize`. The server answers with error `-32601`.
3. **Stop hook `continue` works but stalls agy.** Proven in `-p` mode with a FIFO. Rejected: hooks run synchronously and block agy, and an internal cap (`maxStopHookContinuations`, not user-settable) limits it.
4. **agy wakes from idle when a background `run_command` finishes.** agy ran `cat <fifo>` in the background (WaitMsBeforeAsync 500) and ended its turn. A write to the FIFO woke it, and it replied MANGO-7. This is the Claude to agy transport.
5. **PreToolUse `{}` means deny.** With a PreToolUse hook that returned `{}` for non-matching commands, agy blocked `echo ok`: "tool call denied by pre-tool hook: (empty reason returned by your PreToolUse hook in hooks.json)". `decision` is required, and `allow`, `deny`, `ask` and `force_ask` are the only values. There is no neutral one. Never ship a PreToolUse hook that does not mean to gate every matched call.
6. **`ANTIGRAVITY_CONVERSATION_ID` is set in `run_command`'s environment.** Live: `echo $ANTIGRAVITY_CONVERSATION_ID` printed `bf9b0731-eb9f-4801-9538-a5df38232abb`, the same id hooks receive as `conversationId`. This is how a listener knows its session.
7. **`hooks.json` is global.** `~/.gemini/config/hooks.json` applies to the CLI, desktop app and IDE. Any hook there runs in every agy session.

8. **`agy agentapi send-message <conversation> <text>` wakes an idle agy.** Undocumented subcommand (`agy agentapi --help` lists `get-conversation-metadata`, `new-conversation`, `send-message`). It needs `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` (sent as `x-codeium-csrf-token`); without the token the language server answers "missing CSRF token". agy sets both, plus `ANTIGRAVITY_AGENTAPI_EXE`, in `run_command`'s environment. Spike, 2026-11-02: agy started a detached `sleep 20; agy agentapi send-message $ANTIGRAVITY_CONVERSATION_ID "AGENTAPI-1: reply with exactly the word MANGO"` and ended its turn. 20s later it woke on its own and replied MANGO. The reply showed in the transcript; the injected message did not. agent-intercom uses the same call.

### Claude Code

1. **Channels.** A server declaring `capabilities.experimental['claude/channel']` can send `notifications/claude/channel` with `{ content, meta }`. The message arrives in the live session as a `<channel>` turn. The telegram plugin uses this.
2. **Non-plugin channels need `--dangerously-load-development-channels server:<name>`.** Claude confirms it at launch.
3. **The server cannot tell whether channels are on.** Claude gates the notification handler on its side and sends no signal. A user-scope server would run in every session and in `claude mcp get` health checks, and consume messages nobody sees. Hence `claude-bridge`, which sets `AGENT_BRIDGE_PEER`. Without it the server never consumes.

4. **A plugin monitor wakes an idle session.** Spike, 2026-11-02: a plugin whose monitor tails a file. A line appended while the session sat idle arrived as "Monitor event: ..." and started a new turn on its own.
5. **Monitors get the session.** The monitor process had `CLAUDE_CODE_SESSION_ID`, the project folder as its working directory, and `CLAUDE_CODE_MESSAGING_SOCKET`.
6. **`when: "on-skill-invoke:<plugin>:<skill>"` needs the qualified skill name.** `on-skill-invoke:bridge-spike` never started the monitor. `on-skill-invoke:bridge-spike:bridge-spike` started it on the skill's first run, and not before.
7. **Claude treats monitor output as data, not instructions.** With no skill telling it otherwise, it declined to act on a monitor line ("That text came from the bridge, not from you"). Once the user had invoked a skill saying peer messages arrive this way and should be handled like a colleague's request, it answered.

8. **The inbox socket wakes an idle session.** Spike, 2026-11-02: a detached script wrote one line, `{"type":"user","message":{"role":"user","content":"SOCKET-1: reply with exactly the word PLUM"},"from":"agent-bridge:spike"}`, to `$CLAUDE_CODE_MESSAGING_SOCKET` 20s after the session went idle, with no auth line. Claude started a turn showing "Another Claude session sent a message", with its peer-message caution, and replied PLUM. The socket path is documented (exported to Bash); the line format is not, and comes from agent-intercom (`docs/live-push.md`, MIT). The spike ran from the session's own shell, so Claude may have verified it as an own-child message; a post from the daemon is an ordinary peer message, delivered in prompting sessions and held in bypass-permission sessions.

### The bridge itself

1. **Concurrent spawns orphaned daemons (prototype).** Three prototype daemons were found running at once. Each new one deleted the socket and took over, and the old ones kept stale state. The daemon now takes an exclusive lock file first.
2. **A spawn can lose the lock to a daemon that is shutting down.** Clients respawn every 500ms while the socket refuses connections, until their timeout.
3. **Creating the lock and writing its pid were two steps.** A second daemon could read the empty file in between, treat it as stale and delete it. Found in code review; fixed with a hard-linked temp file (`src/daemon/lock.ts`).

## Decisions

| Decision | Why |
|---|---|
| One daemon, Unix socket, disk queue | Survives restarts. Both MCP servers and the listener are thin clients |
| Ack before dequeue, one message in flight per recipient | No loss when a listener is killed. Keeps order |
| Listener exits after one message | Exiting is what wakes agy |
| Re-arm instruction printed with every message, and in the `/bridge` skill | agy has no persistent subscription. The prompt carries the loop |
| Bind to the newest tagged agy conversation | `hooks.json` is global. Without it any agy session could take messages |
| Old listener wakes with "took over" or "stopped" | So a superseded session stops re-arming instead of waiting forever |
| Listener reconnects on daemon restart | Exiting with no message would wake agy for nothing |
| PreInvocation fallback, never blocks | Covers the case where the listener is not armed. 1.5s cap, `{}` on failure |
| `/bridge` skill, not SessionStart auto-arm | Auto-arm would make every agy session take the binding |
| Hand-written MCP stdio, no MCP SDK | Small surface. Only initialize, ping, tools/list, tools/call. Unit-tested |
| Named peers, one `send` tool with `to` | Same shape for every agent. Any number of sessions |
| One `Adapter` interface, one registry | Only wake, identity and knowledge differ between agents. `ADAPTERS: Record<PeerKind, Adapter>` fails to compile when a kind has no adapter. The hub, tools and CLI core never branch on kind |
| `mcp <kind>`, not env sniffing | An earlier build picked Claude or agy mode from `AGENT_BRIDGE_PEER`. With more kinds that does not scale. Each client's config names its kind |
| A name belongs to one kind | A Claude subscriber and an agy listener under one name would fight over delivery |
| agy passes `as` on each send | agy's MCP server process has no session id. The `/bridge` skill and every message tell agy its name |
| Hub is pure, store injected | Delivery and binding rules are unit-tested without sockets or disk |
| Strict TypeScript, zod at boundaries, tsc to `dist/` | The code grew past what one untyped file holds. Follows the owner's TypeScript rules |
| After a daemon restart, the hook asks agy to rejoin | Hooks lack the token (agy finding/open question 10), so only `join` can register. Drain replies carry `rejoin` once per daemon run for a bound session without an endpoint; the hook injects a one-line request to run `join`. Chosen over saving the token to disk |
| Push runs only an absolute `.../agy` | The endpoint arrives over the socket. The socket is 0600, so this is defence in depth, not a privilege boundary |
| agy receives by agentapi push by default | agy finding 8. No background listener, no re-arm loop. A push endpoint is a listener in the hub (`PushConn`), so delivery, ack and fallback reuse the same rules. The token stays in daemon memory and travels to agentapi in its environment, never its arguments |
| Claude: socket default, monitor and channel by choice | Claude finding 8: the inbox socket wakes an idle session with no plugin component running. Same shape as agy: `join` registers an endpoint, the daemon pushes and acks. The socket path is documented; the line format is not, so the monitor (`/bridge-monitor`) and the channel (`agent-bridge claude`) stay as user choices. No auth line: the daemon is not the session's child, so Claude's inbound controls apply |
| A push next to another receiver is refused | One receive path per session. `join` reports the refusal instead of claiming direct delivery |
| Claude receives through a plugin monitor by default, channels opt-in (superseded by the socket default) | Claude findings 4 to 7: a monitor wakes an idle session, gets the session id, and starts on `/bridge`. No launch flag, no notice. Channels stay for direct push, behind `agent-bridge claude` |
| Listen by session, wait for `claim` | The monitor's command is fixed and starts when the skill is invoked, possibly before `join`. It cannot know the name, so the daemon parks it until the session holds one |
| `join <name>` binds and renames | A later name moves the session's peer: in place if free, carrying queue and listeners, else onto the existing name. A running monitor follows without reconnecting |
| `join` is core, with `--kind` | A shell can carry both agents' session ids (agy started from a Claude terminal inherits Claude's), so skills pass the kind |
| Auto names `<folder>-<kind>[-n]`, never reused while held | Same model as Claude's own session names. No takeover or "is it still active" guesswork for defaults. The daemon assigns names (`claim`) so concurrent starts cannot collide. Explicit names keep takeover for stable roles |
| Prune idle peers: 24h, or 7 days with mail queued | Auto names would otherwise pile up, and a dead peer that keeps receiving would never free its name. Never at startup: listeners have not reconnected. `lastSeen` writes are throttled against the stored value |
| Auto names are locked to their session | Explicit names allow takeover, auto names do not: a stale session re-arming would otherwise steal a name re-claimed after pruning |
| Claude keyed on `CLAUDE_CODE_SESSION_ID` | Claude sets it for MCP servers (checked in the process env). A resumed session keeps its name. Seen to differ between servers of one long-lived session, so `whoami` from Claude's shell can miss |
| Single-instance lock file | Bridge finding 1. The pid goes into a temp file that is hard-linked into place, so the lock never exists empty. A stale lock is renamed aside and checked before takeover. An empty lock is refused until it is 5s old |
| Hook drain is acked after print | The hook's 1.5s cap or agy's 3s kill could fire between drain and print. Drain no longer removes; `ack-drained` does |
| Listener retries every failure to connect | A failed connect or a socket error (ECONNRESET) used to end the listener. agy then woke for nothing, and Claude stopped receiving until restart |
| A superseded waiter finishes its in-flight message first | Evicting it would deliver the message twice. It is told "superseded" on ack, so it cannot take the name back after a daemon restart |

## Rejected

- MCP notifications to agy (finding 1).
- Stop hook continue (finding 3).
- PreToolUse rewrite of `agent-bridge listen` to tag the conversation (finding 5). Replaced by the env var (finding 6).
- User-scope Claude MCP registration (Claude finding 3).
- Checking the parent process for the channel flag instead of `claude-bridge`. It works without a wrapper, but needs a process-tree walk. The wrapper is simpler.
- A Claude skill or plugin that enables *channels* instead of a launcher. Channels turn on only at launch: "no channel runs until a user opts it in for the session with `--channels`" (code.claude.com/docs/en/channels). No user setting enables them. A plugin outside `claude-plugins-official` still needs `--dangerously-load-development-channels`. The launch dialog has no documented skip. Every route needs a launch flag, and `claude-bridge` is the smallest one.
- SessionStart hook that auto-joins agy. Every agy session would join and take the binding from the real one. `/bridge` is explicit.
- Fixed sleeps in e2e tests. They flaked under load (a listener killed before it registered). Tests wait on conditions.

## Live test log

- **2026-11-01.** MCP push spike, Stop hook spike, FIFO wake (MANGO-7).
- **2026-11-02.** PreToolUse `{}` blocked `echo ok`. Hook disabled at once, PreToolUse removed.
- **2026-11-02.** Env var confirmed. `agent-bridge listen` in the background bound the daemon to `bf9b0731-...`. A shell send woke idle agy. agy replied PAPAYA-9 via `send_to_claude` (queued for Claude) and re-armed the listener on its own.
- **2026-11-02.** Prototype to TypeScript rebuild: three prototype daemons found running at once (bridge finding 1). `PAPAYA-9` was no longer queued before the upgrade; what consumed it is unknown.
- **2026-11-02.** Auto names live: `/bridge` in agy ran the skill (`join`, background `listen --as agent-bridge-agy`, `status`) and joined as `agent-bridge-agy`. A `claude-bridge` session in the same folder showed as `agent-bridge-claude`, online. Claude printed "server:agent-bridge · no MCP server configured with that name" at launch, yet received channel pushes.
- **2026-11-02.** Both default paths live, both ways. agy `/bridge` joined as `agent-bridge-agy` with direct delivery (no listener). Plain `claude` ran `/agent-bridge:bridge`, joined as `agent-bridge-claude-2`, monitor running. agy sent a question; idle Claude woke on a monitor event and replied with `agent-bridge send`. The reply reached agy by agentapi push, agy woke, answered with "From agent-bridge-claude-2:", and Claude woke again for the answer. No launch flags, no banner.
- **2026-11-02.** Rejoin hint live. After `agent-bridge install` restarted the daemon, an agy turn showed the injected line "Direct delivery to this session is off ... Run `agent-bridge join --kind agy`", ran `join`, answered the user, and `agent-bridge-agy` was online again. The injected hint is visible in agy's transcript as a user-style message. The turn before it ("hi") got no hint; the cause was not checked.
- **2026-11-02.** Claude receive modes live. Socket mode (`/bridge`): agy's message, posted by the daemon (not the session's child, no auth line), woke an idle prompting Claude session as a message from another session, and it replied. Monitor mode (`/bridge-monitor`) still worked in a second session.

## Adding an agent

An adapter answers three questions for its agent:

1. **Wake.** How does a message reach an idle session? Options seen so far, in order of preference:
   - push into the live session (Claude channel),
   - a background command whose exit wakes the agent (agy `listen`),
   - a hook that injects messages at the agent's next model call (agy PreInvocation). This only fires when something else starts a turn.
2. **Identity.** Which session is which? An env var the agent sets for commands, a hook field, or a launcher that sets one.
3. **Knowledge.** How does the agent learn the protocol? MCP `instructions` are enough when the client shows them and loads the server only in bridge sessions (Claude). Add a skill or slash command when joining takes an action, or when the client does not show instructions (agy `/bridge`). Do not install a skill that loads in sessions not on the bridge.

Steps:

1. Add the kind to `PEER_KINDS` in `src/schema.ts`. `src/adapters/index.ts` now fails to compile.
2. Create `src/adapters/<kind>/`. Its `index.ts` exports the `Adapter` (`src/adapters/types.ts`) and nothing else. Split the rest by concern (`mcp.ts`, `install.ts`, a listener, launcher or hook), with any skill or asset the agent needs alongside:
   - `serveMcp`: `serveStdio(createMcpHandler({ instructions, tools: bridgeTools({ self }) }))` for a fixed-name server, or `bridgeTools({ asHelp })` when the agent passes its name per call, plus the wake path built on `holdListen` or `request({ op: 'drain' })`.
   - `commands`: any launcher, listener or hook the agent calls. Names must be unique across adapters.
   - `install` / `uninstall`: the agent's config, written with the helpers in `src/lib/config.ts`. Point its MCP entry at `agent-bridge mcp <kind>`. Touch only our own entries.
   - `joinHint`: one line shown after install.
3. Register it in `ADAPTERS`.
4. Prove the wake live once, like MANGO-7 and PAPAYA-9, and record it in the live test log above. A kind without a wake mechanism can still send. It receives only when the user types to it, via a hook.
5. e2e coverage in `test/e2e.test.ts`.

## Open questions

1. Can the user type to agy while the listener runs?
2. Does agy re-arm reliably over many turns? (Seen once.)
3. Does a background `run_command` time out and kill a listener left waiting for hours?
4. Does the PreInvocation fallback fire live?
5. agy to Claude through a live `claude-bridge` session.
6. Two agy sessions under different names at once, live.
7. ~~Does `/bridge` invoke the skill as a slash command?~~ Yes (live, 2026-11-02).
8. ~~Is the cwd the project folder in both agents?~~ Yes: both got `agent-bridge-<kind>` (live, 2026-11-02).
9. Does `claude --resume` keep `CLAUDE_CODE_SESSION_ID`, and so the auto name?
10. ~~Does agy's PreInvocation hook get `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`?~~ No. A probe hook (2026-11-02) saw only `ANTIGRAVITY_CONVERSATION_ID`. Only `run_command` gets the address and token, so only `join` can register the push endpoint.
11. Does `agentapi send-message` still work after agy restarts and resumes the same conversation (new address)?
